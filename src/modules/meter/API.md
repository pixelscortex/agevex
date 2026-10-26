# Meter API

Mount `agevex/meter/convex.config` independently of core. Import
`defineMeter`, `inline`, `polarSink`, `webhookSink`, `usageHandlerFor`, and
`observeProviderOutcome` from `agevex/meter`. Wire the core usage and budget
slots explicitly; core never imports this module.

```ts
// convex/billing.ts
import { defineMeter, inline, polarSink } from "agevex/meter";
import { components, internal } from "./_generated/api";

export const meter = defineMeter(components.meter, {
  providers: {
    openrouter: inline(),
    fal: { profiles: { image: { unit: "image", usd: 0.04 } } },
    firecrawl: { credits: { usdPerCredit: 0.001 } },
    // A lookup must only read billing evidence; never repeat a paid operation.
    // asynchronous: { lookup: async (ctx, requestId) => ..., lookupFor: "1h" },
  },
  sinks: [polarSink({ meter: "ai_usage", accessToken: process.env.POLAR_ACCESS_TOKEN! })],
  workers: { deliver: internal.billing.meterDeliver, lookup: internal.billing.meterLookup },
  budgets: () => ({ maxUsd: 5 }),
});
export const { meterLookup, meterDeliver } = meter.internalFunctions();
```

`workers` points to the two exported **internal** host actions so callbacks and
credentials remain in host code. A lookup provider requires its lookup worker;
sinks require the delivery worker. Custom sinks accept `{ deliver(batch) }`,
optionally `name`; keep unnamed sinks in stable array order across deployments.
Built-in sinks and custom sinks may be named explicitly.

## Wire it into agevex

```ts
const runtime = registerAgent(components.agevex, {
  agents: [main],
  authorize,
  refs,
  usage: meter.usageSlot(),
  budget: meter.budgetSlot(),
});
```

`usageSlot(options?: { providers?: Record<string, string> }): UsageSlot` passes
core attribution and hashed keys unchanged to the meter. Managed tools get
`tc.meter`; core records each saved model step once and adds no charges on
replay. Do not also install `usageHandlerFor` on these managed agents.

Core passes the Agent's stored `message.provider`, the AI SDK provider id
(`"openrouter.chat"` for `@openrouter/ai-sdk-provider`), else `"model"`. The
slot resolves an exact registered name, then an explicit
`usageSlot({ providers: { "<sdk id>": "<registered name>" } })` mapping, then
the longest registered dotted prefix (`google.vertex.chat` resolves to `google.vertex` before `google`), so `openrouter: inline()` prices
`"openrouter.chat"`. An unresolved name is recorded `unknown` and denies the
next slice. A model id over 128 bytes is stored as `sha256:<hex>`.

`budgetSlot(policy?: MeterOptions["budgets"]): BudgetSlot` checks the run
before each next model call and local tool effect, using the configured policy unless overridden. Estimates
count; unknown costs and authorization/read/policy errors fail closed with
`BUDGET_EXCEEDED`. The gate is a snapshot, not a spend reservation.

## Standalone recording

```ts
const scoped = meter.scope(ctx, {
  subject,
  rootThreadId,
  threadId,
  runId,
  agent: "Builder",
  model,
});
const charge = await scoped.estimate("fal", {
  key: toolCallId,
  profile: "image",
  quantity: 6,
});
await charge.attach({ requestId, key: `${toolCallId}:attach` });
await charge.correct({ quantity: 5, key: `${toolCallId}:correct` });
await charge.settle({ usd: 0.19, key: `${toolCallId}:settle` }); // or credits: 3
```

Keys are required, unique within the mount, and bounded to 256 UTF-8 bytes.
The substring `:delta:` is reserved so a new charge cannot collide with a
correction event's external id.
Replays return the same charge; conflicting provider/attribution throws
`KEY_CONFLICT`. Repeating a correction or settlement does not add another
contribution. `correct` reprices the quantity from the registered profile and
marks it `source: "estimate"`; a later settlement supplies authoritative cost.
Settlement is final: subsequent amount changes are ignored. Corrections also
cannot revive an expired `unknown`; only real provider evidence can settle it.
Every `correct`, `attach` and `settle` call requires a stable operation `key`
(up to 256 UTF-8 bytes), shared across these methods for one charge. Reuse it
for retries; use a new key for each distinct operation. A repeated key returns
the original charge snapshot without changing current state, totals, jobs or
sinks, even if its arguments differ. `get()` returns current state. Revisions
only describe amount transitions; there is no revision argument or fallback.

The charge retains at most `LIMITS.maxOperations` (32) operation receipts. A
new key at capacity throws `OPERATION_CAPACITY`; old keys remain replayable.
Receipts are never evicted: forgetting a key would make a delayed correction
look new again. This lifetime cap preserves both replay safety and the exact
original outcome with bounded storage; plan for settlement within the cap.
Rejected-by-state operations also save their result, while validation errors
and request-id conflicts consume no slot.

Once core wiring lands, keys inside agent tools will default to `tc.toolCallId`.
For several distinct operations within one tool call, pass explicit keys with
a distinct suffix per operation, as above. Standalone calls require explicit
keys today. Core is unchanged. The bounded `lastStale` diagnostic records the
latest rejected operation and observed amount revision. Lookup and delivery
keep their request-id/deadline, attempt and external-id fences.
Profile assumptions are host configuration, not provider facts. Fal and Daytona
have no per-request cost endpoint. Firecrawl credits require an explicit plan
rate; they are not dollars.

`scoped.record(provider, { key, usage, providerMetadata, requestId? })` uses the provider's
inline decoder, then its optional `estimate({ usage, model })` callback when
inline evidence is missing. The default `inline()` reads
`providerMetadata.openrouter.usage.cost`; a valid zero settles, absent evidence
stays unknown unless an estimate is configured. Alternate decoders can return `{ usd }` or `{ credits }`.
`get()` reads one charge by its exact key.

`record` and `estimate` never throw for a charge they cannot price: they record
it `unknown` with `reason`, and `check` denies. Reasons: `NO_COST` (no
evidence), `DECODE_FAILED`, `INVALID_COST`, `OVER_CAP` (above $90),
`PROVIDER_NOT_REGISTERED`, `PROFILE_NOT_REGISTERED`, `THREAD_CAPACITY`. A
later USD `settle` resolves it. Malformed keys, names and quantities still throw.

Budgeting and billing differ: `unknown` always denies `check`, but a known
amount is still billed. A `THREAD_CAPACITY` charge with a settled/inline
amount and an `OVER_CAP` charge (its full amount is kept) are delivered to
sinks; unknown estimates are not. `correct`/`settle` and lookup results above $90 likewise become `unknown` / `OVER_CAP` with the amount, instead of throwing. Reads under-report them: `threadCost`, `subjectCost` and `breakdown` count at most $90 per `OVER_CAP` charge, while sinks bill the full amount.

Reads return integer `totalNanos`, `settledNanos`, `estimatedNanos`, `unknown`,
`unknownNanos`, plus convenience USD fields. Unknowns retain their last known
estimate separately and always deny `check`; unknown is never interpreted as
free. `check({ subject, runId })` includes estimates and checks that run;
omitting `runId` checks the subject's lifetime total. A gate is a snapshot,
not an atomic reservation for future work.

`threadCost(ctx, { threadId })` takes the root id and includes children whose
attribution supplies that `rootThreadId`. Standalone hosts supply the root;
the meter does not discover relationships by scanning Agent messages.
It always includes `byAgent`; `byModel` and `byProvider` are optional fields,
present only with `breakdowns: ["thread.model", "thread.provider"]` respectively.
Each is `{ page, cursor }`, with up to `limits.maxGroups` (hard maximum four) groups. Each page entry includes
the same cost/unknown fields as the total. Continue independently with
`threadCost(ctx, { threadId, cursors: { agent, model, provider } })`; omit a
cursor to restart that axis. Missing agent/model labels are grouped under `""`.
`subjectCost(ctx, { subject, runId? })` supplies subject/run totals.
`breakdown(ctx, { subject, from, to, by, cursor? })` supports UTC-day,
agent, model, and provider grouping. Dates are UTC-midnight milliseconds,
`from` inclusive / `to` exclusive. Day ranges contain at most seven days.
Other axes return up to four groups with an exclusive cursor; groups without
charges in that date range have zero totals. Follow the cursor to enumerate
all groups. These reads query aggregates, never scan charge documents.

`defineMeter` defaults to `breakdowns: []`. Opt in to any of `"thread.model"`,
`"thread.provider"`, `"subject.agent"`, `"subject.model"`, or `"subject.provider"`.
Subject day reads always work; other subject axes require the matching option.
A disabled subject axis or thread axis cursor throws `BreakdownDisabledError`
with `code: "BREAKDOWN_DISABLED"` and `breakdown` naming the option to enable.
The exported `ThreadCost` type makes model/provider pages optional.
Enabling a breakdown later covers only charges recorded from then on; no backfill is performed.

This library exposes no browser-facing host endpoints. Authorize every public
wrapper using the host's ownership policy. Background workers are internal,
and charges are addressed by stored keys.

Host `authorize(ctx, scope)` guards host-facing calls: `scope`, `threadCost`,
`subjectCost`, `breakdown`, `check` and `retrySinks`. The slot adapters
(`usageSlot`, including `tc.meter`, and `budgetSlot`) skip it: they trust
whatever attribution core passes and run in background actions without user
identity. Core derives that attribution for managed turns, but
`runtime.runTask(ctx, task, input, { attribution })` forwards host-supplied
attribution, which must therefore be server-derived, never client input.
`prune` is a host admin operation, like extract's `purge`: it performs no
`authorize`; expose it only behind your own admin check.

## Saved Agent steps

For standalone calls outside the core usage slot, Agent **0.7.7** invokes
`usageHandler` once after saving each model step, but
does not pass a message id or step ordinal. Supply the identity from the host's
generation context; no transcript scan or random fallback is used:

```ts
const usageHandler = usageHandlerFor(meter, {
  provider: "openrouter",
  identity: () => ({ subject, rootThreadId, runId, messageId: promptMessageId, step: 0 }),
});
```

For multiple steps, `identity` must return the corresponding stable step
ordinal. The key is the JSON tuple `[threadId, messageId, step]`. Replaying the
same hook input with the same identity records once. Embeddings without thread
identity need an explicit scoped record. Set OpenRouter `usage: { include: true }`.
`observeProviderOutcome` preserves the provider result or original provider
error even when billing decoding or an evidence observer fails.

## Lookup and delivery

Managed model calls save exact response ids in native metadata alongside usage.
`record` stores supplied ids atomically with the charge. Core's slice-exit
`usage.reconcile` asks meter to discover pending ids through
`(attribution.subject, attribution.runId, reconciliation)`, including finished
children. Each transaction admits at most four lookups and removes those rows
from the pending index; scheduled successors stop when empty. Standalone hosts
call `meter.reconcile(ctx, { subject, runId })` as an explicit backstop.

`openRouterProvider({ apiKey, estimate?, fetch?, lookupFor? })` uses inline usage
cost and a read-only OpenRouter generation lookup. The HTTP response is limited
to 16 KiB and 30 seconds; the returned id must match. Other providers implement
`Provider.lookup`. `tokenEstimate({ inputUsdPerMillion, outputUsdPerMillion })`
prices native saved usage or SDK usage using configured rates, never a guessed
price. Estimates and authoritative corrections use the same charge key.

`meter.usageView(ctx, { subject, runId, nodeIds, partial? })` authorizes and returns
`{ total, nodes: [{ nodeId, usage }] }`. Supply at most 59 known node ids (`null`
is root); the root total always covers the whole run, independently of the node
selection. Values contain input/output tokens (null if absent), estimated and
settled USD, unknown count and reporting coverage. Core slots trust server-derived
facts and expose the same optional view. Propagate `runs.usagePartial` via
`turns.slices.usageReporting` as `partial`; omitted adapters report disabled.
The node label is an exclusive delegation id, and `purpose` is agent/tool/title/summary.
No enriched run tree or metadata worker is introduced by this contract.

The existing aggregates gain at most five entries per charge: exclusive node
cost and run/node token sums (or missing-model-token counts). At all opt-ins,
13 projections replace <=3,061 nodes read (<6 MiB) and <=1,942 written (<3.8 MiB),
plus bounded charge receipts/outbox. A 59-node view reads complete namespaces:
60 × 8 aggregate operations × <=7 documents =3,360 documents, <7 MiB plus small
query metadata, <4,096 queries; output <32 KiB. No charge/transcript scans.

Charges expose reconciliation status: pending, running, complete, unavailable,
exhausted. Missing/failed lookups retain existing amounts, and retries only read
evidence. No request id means unavailable; a later `attach` can supply it.
An exhausted horizon leaves the stored estimate unknown for budget admission.
Managed observation failures are fail-open for paid outcomes and sticky partial
for reporting. An authoritative inline zero is real evidence and skips lookup.

Attaching a request id starts one Workpool lookup sequence with exponential
backoff, capped at eight evidence reads, plus a one-shot deadline mutation.
The deadline marks unresolved charges unknown even if a worker crashes or
exhausts retries. Reattaching the same id schedules no duplicate sequence;
a different id throws. Expiry does not restart lookup work; a real result
already in flight may still settle the unknown exactly once. Replayed attempt
callbacks cannot create duplicate retry chains. No
provider operation that incurs cost is invoked by this module.

Billable charges enter the durable sink outbox (`deliveries`): settled and corrected ones, plus unknown charges with a known amount (`THREAD_CAPACITY` with a settled/inline/lookup amount, `OVER_CAP`).
One delivery job drains up to 100 due events of one sink into one `deliver`
call, i.e. one Polar ingest request; new events wait one second so bursts
share a request. Sink errors retry with backoff and stable external ids, at
most eight attempts. A 429 with `Retry-After` reschedules once at that delay
without consuming an attempt; the next consecutive 429 consumes one. A
crashed or cancelled job counts as one failed attempt for the rows it claimed
(Workpool `onComplete`, with a claim marker) and charges no other row; a job that died before claiming is retried up to seven times without charging, then its sink's due rows take one attempt, so a worker that can never run still drives them to `failed`.
Recording does not wait for the sink. Failed deliveries stay pending;
`retrySinks(ctx, { key, subject })` resumes them. With `maxAttempts: 1` a single pre-claim crash fails the sink's due rows at once; keep it at 2 or more. Jobs run only on demand.

First delivery uses `externalId = charge.key`. Subsequent corrections send
**signed nanodollar deltas** under `key:delta:revision`, with `totalNanos` for
the new absolute amount. An in-flight event's amount and id stay frozen until
acknowledgement, then another delta catches up. Every sink must durably dedupe
external ids. Replayed HTTP requests are not new billable events. Configure
Polar's meter to **sum numeric `metadata.nanos`**, including negative deltas;
`_cost.amount` is a JSON decimal **number in cents**, with up to 17 digits and
12 decimal places ([Polar cost metadata schema](https://polar.sh/docs/features/cost-insights/cost-events#cost-metadata-schema)).
Integer division/remainder emits exact signed cents with at most seven places;
290,000,000 nanos becomes `29`, without float conversion. Webhooks receive `{ events }` with
the same ids/deltas. Acknowledgements are recorded 16 per mutation.

## Retention

`meter.prune(ctx, { before, limit? })` deletes up to `limit` (default 100,
max 500) settled charges whose sinks all acknowledged, created before
`before`, with their aggregate contributions; it returns `{ deleted, more }`
and also stops early at its transaction budget. Call it from a host cron (server-only; it performs no `authorize`) until `more` is false; it never reschedules itself. Totals then
cover retained charges only. Choose `before` past any replay window: a pruned
key recorded again is a new charge. `before` must precede every active run and budget window: pruning lowers
run and subject totals. `prune` refuses a cutoff newer than now minus
`limits.pruneMinAgeMs` (7 days; hosts may lower it) with `PRUNE_TOO_RECENT`.

## Owned schema and bounds

`charges`, its sink outbox `deliveries` and delivery-job `claims` markers are owned. Aggregate and Workpool
own their own component state.

| Field                                                      | Reader / purpose                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `key`                                                      | Unique indexed lookup, replay detection, job addressing and first external id.                                      |
| `attribution.subject`                                      | Subject totals, budget gates, axis namespaces, sink customer id and retry authorization.                            |
| `attribution.rootThreadId`, `threadId`                     | Root/child aggregate attribution and fallback for standalone root charges.                                          |
| `attribution.runId`                                        | Run-scoped aggregate namespace and budget gate.                                                                     |
| `attribution.agent`, `model`                               | Thread agent key, thread model grouping and subject axis projections.                                               |
| `provider`                                                 | Registered decoder/lookup routing and provider breakdown/sink metadata.                                             |
| `breakdowns`                                               | Frozen opt-ins used by corrections, settlement and workers to replace exactly the projections written at creation.  |
| `profile`, `quantity`                                      | Profile selection for quantity corrections and retained quantity on settlement; exact evidence via `get`.           |
| `status`, `source`                                         | State transitions, unknown fencing, estimated/settled aggregate classification and sink eligibility.                |
| `nanos`, `credits`                                         | Exact aggregate summand / provider credit evidence and settlement result.                                           |
| `providerRequestId`, `lookupUntil`                         | Lookup identity, reattach conflict detection, deadline and stale-result fencing.                                    |
| `revision`                                                 | Monotonic amount revision returned with the saved outcome; no longer used as a correction input.                    |
| `lastStale.{operation,revision}`                           | Latest rejected operation and observed revision exposed by `get`.                                                   |
| `operations[].key`                                         | Bounded charge-wide replay lookup before any state change or worker admission.                                      |
| `operations[].outcome`                                     | Original charge snapshot returned on replay; excludes operations to prevent recursive growth.                       |
| `lookupAttempt`                                            | Next admissible lookup attempt; rejects duplicate retry admission and stale workers.                                |
| `reason`                                                   | Why the charge is unknown (`OVER_CAP` may also come from `correct`/`settle`); `THREAD_CAPACITY` routes to overflow. |
| `sinkState.name`                                           | Sink routing.                                                                                                       |
| `sinkState.deliveredNanos`, `revision`                     | Next signed delta and stable external id.                                                                           |
| `sinkState.pending.{externalId,revision,nanos,totalNanos}` | Immutable delivery snapshot, acknowledgement fence and absolute delivered amount.                                   |
| `terminal` (indexed)                                       | Settled with every sink acknowledged: the only rows `prune` reads.                                                  |
| `_creationTime`                                            | UTC day ordinal, stable across corrections; `prune` cutoff.                                                         |
| `deliveries.{sink,key,event,attribution,provider}`         | One row per pending (charge, sink) event: what a job sends, read without loading charges.                           |
| `deliveries.{attempts,limited,failed,dueAt,claim}`         | Backoff, 429 allowance, terminal failure, due order and the job holding it (crash accounting).                      |
| `claims.claim`                                             | Marker that a delivery job claimed its batch; its `onComplete` then charges only that job's rows.                   |

There is no deployment-wide capacity and no read of a shared tree. Every
aggregate namespace belongs to one subject or one root thread. A root thread
holds at most 100,000 charges in its paged trees (`limits.maxThreadCharges`);
past that a charge is recorded `unknown` (`THREAD_CAPACITY`) in a count-only
overflow namespace that `threadCost` totals still include, and `prune` frees
room. A charge is at most $90 (90 billion nanos), so a capped tree sums to at
most `100,000 × 9×10^10 = 9×10^15 < 2^53` nanos, exactly. Subject totals are
exact below $9.007M of retained charges. Keys are at most 256 UTF-8 bytes;
labels at most 128; quantities/credits at most one million; four sinks; 16
providers; 32 profiles/provider. Overrides can only lower prune minimum age, thread capacity,
groups, days and attempts. A charge snapshot stays below 8 KiB; with receipts
the row stays below 280 KiB:
`32 × (8 KiB + 256-byte key + 128-byte wrapper) + 8 KiB = 276 KiB < 1 MiB`.

Defaults write **three projections/charge** (two without run, one without
thread); all breakdowns write **eight**. `state` is estimate, settled or unknown.

| Mount / namespace                           | Key           | Why it exists                                |
| ------------------------------------------- | ------------- | -------------------------------------------- |
| `costByThread / [thread,root,state]`        | `[agent,day]` | Root + children totals and agent pages.      |
| `costByThread / [overflow,root,state]`      | `[agent,day]` | Counted totals of over-capacity charges.     |
| `costBySubject / [subject,subject,state]`   | `["",day]`    | Subject totals and UTC day ranges.           |
| `costBySubject / [run,subject,runId,state]` | `["",day]`    | Run totals and budget checks.                |
| `costBySubject / [axis,subject,axis,state]` | `[label,day]` | Subject agent/model/provider pages (opt-in). |
| `costBySubject / [thread,root,axis,state]`  | `[label,day]` | Thread model/provider pages (opt-in).        |

Roots stay lazy (the Aggregate default); empty namespaces are initialized
with four-item nodes (<=2 KiB) after a one-path emptiness probe. Totals and
`check` read whole owned namespaces: the root plus <=5 children, independent
of size. Thread trees have depth <=10; subject/run trees use a design ceiling
of 24 (depth 25 needs ~5.6×10^11 charges for one subject). Worst cases:

- One status change, eight projections: <=1,706 node reads (<3.4 MiB) and
  <=1,082 writes (<2.2 MiB), plus the <=280-KiB charge (<=3 patches), <=4 outbox
  rows and Workpool admissions. **One charge per mutation**.
- An axis page: 31 aggregate queries, <=5,952 node reads (<11.7 MiB). Seven
  days: `7 × 4 × 192 × 1 KiB = 5.25 MiB`.
- Thread pages: `3 × (15 × 30 + 16 × 80) × 2 KiB = 10.14 MiB`, plus O(1) totals.
- A delivery job: claim <=100 outbox rows (<=200 KiB); acknowledge 16 per
  mutation (`16 × 280 KiB = 4.4 MiB`). Crash accounting touches outbox rows only.
- `prune`: each row costs its size plus `8·D+4` node reads per projection; the
  batch stops below 16k docs / 12 MiB, i.e. >=9 default (476 nodes plus a
  280-KiB row) or >=4 fully opted-in (1,232 nodes) charges per call at worst case.

All fake tests enforce Convex transaction limits. The maximum test builds
99,999-entry fixtures for **every projection** of one root thread, spanning
every status, five maximum-byte labels and seven days. It admits the last
charge, corrects/settles it with maximum UTF-8 fields, a full receipt ledger
and four sinks, reads maximum pages and seven days, records the next charge as
`THREAD_CAPACITY`, and prunes the delivered maximum charge.

Source references used: Aggregate `src/client/index.ts:866-915`,
`src/component/btree.ts:56-138,333-415,590-805,1048-1084`; Workpool
`src/client/index.ts:95-120,402-413,487-498,576-589`; Agent 0.7.7
`src/vercel/client/types.ts:288-302`, `start.ts:425-437`. The scouts identify
Polar's ingest/dedup contract and the absence of per-request Fal/Daytona costs.

## Specification corrections

- Two leading tuple keys alone cannot answer provider/run/non-leading date
  breakdowns in O(log n). Additional opt-in namespaces/projections in the same
  two mounts are necessary; the maximum replacement budget includes eight projections.
  The thread key drops its redundant trailing model to keep two-field nodes
  bounded while separate model/provider projections support thread axes.
- Agent 0.7.7's usage hook lacks message/step ids. `usageHandlerFor` therefore
  requires a host identity callback; it cannot safely infer a key from the hook.
- The examples omit recording keys. Standalone calls require an explicit key;
  core's usage slot supplies hashed ToolContext keys. Mutations after
  creation also require their own stable operation keys; fetching the current
  revision on replay cannot prevent an older correction from being applied again.
- A delivered correction needs a new external id for its delta; reusing the
  base charge key would make Polar discard it as a duplicate.
- Settled amounts are final; deltas apply to corrected estimates and their
  final settlement. Expired unknowns accept real results already in flight,
  without restarting provider work. Thread axes require cursor pages to stay
  bounded at arbitrary cardinality.
- USD is represented by `nanos`, rather than the draft schema's floating `usd`.
  `source` is persisted to distinguish corrected estimates from authoritative
  settlement and prove valid inline zero cost. Estimates use the registered
  profile assumptions; this brief does not add the draft's separate pricing
  version catalog, gateway integration or embedding middleware.

`bun run test:meter:live` performs one OpenRouter `openrouter/free` generation
through the real Agent hook, with no automatic model retries or Polar calls.
It reads the named private environment file (or process environment), never
prints credentials, and writes `.vite-plus/meter-live-results.json`.
