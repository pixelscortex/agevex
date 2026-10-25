# Meter

Mount `agevex/meter/convex.config` independently of core. Import
`defineMeter`, `inline`, `polarSink`, `webhookSink`, `usageHandlerFor`, and
`observeProviderOutcome` from `agevex/meter`. No runtime or ToolContext wiring
is included; core never imports this module.

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
await charge.attach({ requestId });
await charge.correct({ quantity: 5 });
await charge.settle({ usd: 0.19 }); // or { credits: 3 }
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
Each amount transition advances `revision`. For replayable application steps,
persist the observed revision and pass `correct({ quantity, revision })`; a
stale revision cannot overwrite a newer correction. Without that argument the
client reads the current revision before submitting the mutation. The bounded
`lastStale` diagnostic records the latest rejected operation/revision; replaying
that same rejection is a no-op. Creation, attachment, lookup and delivery use
the charge key, request id/deadline, attempt and external id as their fences.
Profile assumptions are host configuration, not provider facts. Fal and Daytona
have no per-request cost endpoint. Firecrawl credits require an explicit plan
rate; they are not dollars.

`scoped.record(provider, { key, usage, providerMetadata })` uses the provider's
inline decoder. The default `inline()` reads
`providerMetadata.openrouter.usage.cost`; a valid zero settles, absent evidence
stays unknown. Alternate decoders can return `{ usd }` or `{ credits }`.
`get()` reads one charge by its exact key.

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
wrapper using the host's ownership policy. The optional `authorize(ctx, scope)`
guard runs before every client read/write and can also use `ctx.auth`.
Background workers are internal, and charges are addressed by stored keys.

## Saved Agent steps

Agent **0.7.7** invokes `usageHandler` once after saving each model step, but
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

Attaching a request id starts one Workpool lookup sequence with exponential
backoff, capped at eight evidence reads, plus a one-shot deadline mutation.
The deadline marks unresolved charges unknown even if a worker crashes or
exhausts retries. Reattaching the same id schedules no duplicate sequence;
a different id throws. Expiry does not restart lookup work; a real result
already in flight may still settle the unknown exactly once. Replayed attempt
callbacks cannot create duplicate retry chains. No
provider operation that incurs cost is invoked by this module.

Only settled/corrected charges enter the durable sink outbox. Delivery actions
catch sink errors, honor `Retry-After`, and retry with stable external ids, at
most eight attempts. Recording does not wait for the sink. Failed/uncertain
pending deliveries remain on the charge; `retrySinks(ctx, { key, subject })`
explicitly resumes them. Workers stop when no pending work remains.

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
the same ids/deltas. Built-in adapters split batches at 100; the worker delivers
one charge event at a time, keeping transaction budgets independent of HTTP
batch capacity. No in-process delivery buffer is used.

## Owned schema and bounds

Only `charges` is owned. Aggregate and Workpool own their own component state.

| Field                                                      | Reader / purpose                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `key`                                                      | Unique indexed lookup, replay detection, job addressing and first external id.                                     |
| `attribution.subject`                                      | Subject totals, budget gates, axis namespaces, sink customer id and retry authorization.                           |
| `attribution.rootThreadId`, `threadId`                     | Root/child aggregate attribution and fallback for standalone root charges.                                         |
| `attribution.runId`                                        | Run-scoped aggregate namespace and budget gate.                                                                    |
| `attribution.agent`, `model`                               | Thread agent key, thread model grouping and subject axis projections.                                              |
| `provider`                                                 | Registered decoder/lookup routing and provider breakdown/sink metadata.                                            |
| `breakdowns`                                               | Frozen opt-ins used by corrections, settlement and workers to replace exactly the projections written at creation. |
| `profile`, `quantity`                                      | Profile selection for quantity corrections and retained quantity on settlement; exact evidence via `get`.          |
| `status`, `source`                                         | State transitions, unknown fencing, estimated/settled aggregate classification and sink eligibility.               |
| `nanos`, `credits`                                         | Exact aggregate summand / provider credit evidence and settlement result.                                          |
| `providerRequestId`, `lookupUntil`                         | Lookup identity, reattach conflict detection, deadline and stale-result fencing.                                   |
| `revision`                                                 | Monotonic amount revision; rejects a correction from an older snapshot.                                            |
| `lastStale.{operation,revision}`                           | Bounded stale-operation diagnostic via `get`; identical stale replay skips its write.                              |
| `lookupAttempt`                                            | Next admissible lookup attempt; rejects duplicate retry admission and stale workers.                               |
| `sinkState.name`                                           | Sink routing.                                                                                                      |
| `sinkState.deliveredNanos`, `revision`                     | Next signed delta and stable external id.                                                                          |
| `sinkState.pending.{externalId,revision,nanos,totalNanos}` | Immutable delivery snapshot, acknowledgement fence and absolute delivered amount.                                  |
| `sinkState.attempts`, `failed`                             | Bounded backoff, terminal failure and explicit recovery.                                                           |
| `_creationTime`                                            | UTC day ordinal, stable across corrections.                                                                        |

`LIMITS` caps the entire mount at 100,000 charges, each at $10 (10 billion
nanos), so even the maximum sum is exactly representable: **10^15 nanos**.
At capacity, reads and existing-charge updates continue; new keys fail with
`METER_CAPACITY`. Capacity management/retention is outside this module. Keys
are at most 256 UTF-8 bytes; labels are at most 128; quantities/credits at most
one million; four sinks; 16 providers; 32 profiles/provider. Overrides can only
lower charge capacity, groups, days and attempts; registration rejects invalid
limits, prices and missing worker references. Each charge stays below 8 KiB.

Two aggregate mounts use status, axis and run namespaces. Defaults write **three
projections/charge**; all breakdowns write **eight**. Without run attribution,
these become two and seven. `state` below is estimate, settled or unknown. Each
row contributes once per projection, never once per state.

| Mount / namespace                               | Key              | Why it exists                                | Per-charge write cost                         |
| ----------------------------------------------- | ---------------- | -------------------------------------------- | --------------------------------------------- |
| `costByThread / [cost,state]`                   | `[root,agent]`   | Root + children totals and agent prefixes.   | One insert / one replace.                     |
| `costBySubject / [cost,state]`                  | `[subject,day]`  | Capacity, subject totals and UTC day ranges. | One insert / one replace.                     |
| `costBySubject / [run,subject,runId,state]`     | `["",day]`       | Run totals and budget checks.                | One insert / one replace if runId exists.     |
| `costBySubject / [axis,subject,agent,state]`    | `[agent,day]`    | Subject agent/date pages.                    | One insert / replace with `subject.agent`.    |
| `costBySubject / [axis,subject,model,state]`    | `[model,day]`    | Subject model/date pages.                    | One insert / replace with `subject.model`.    |
| `costBySubject / [axis,subject,provider,state]` | `[provider,day]` | Subject provider/date pages.                 | One insert / replace with `subject.provider`. |
| `costBySubject / [thread,root,model,state]`     | `[model,day]`    | Thread model prefixes across all agents.     | One insert / replace with `thread.model`.     |
| `costBySubject / [thread,root,provider,state]`  | `[provider,day]` | Thread provider prefixes across all agents.  | One insert / replace with `thread.provider`.  |

Each insert is roughly 12 upstream document writes; replacement is roughly 24
(delete + insert). Aggregate document writes per charge, excluding the charge
row and optional Workpool admissions:

| Configuration               | Projections with run / without run | Insert writes with run / without run | Replacement writes with run / without run |
| --------------------------- | ---------------------------------- | ------------------------------------ | ----------------------------------------- |
| Defaults (`breakdowns: []`) | 3 / 2                              | ~36 / ~24                            | ~72 / ~48                                 |
| All five breakdowns enabled | 8 / 7                              | ~96 / ~84                            | ~192 / ~168                               |

The conservative bound is 48 / 96 split/merge operations **per projection**;
state movement is included in replacement, not another projection. Stale/replay
operations do no aggregate writes (a new stale diagnostic patches one row).

Default 16-item lazy nodes do not
give a tight byte budget for many range queries, so empty namespaces are
initialized with four-item nodes and eager aggregates. At 100k entries their
depth is below 12. Two-field keys keep every node <=2 KiB. Conservative bounds:

- One status change: eight replacements, up to `8 × 2 × 12 × 4 = 768`
  split/merge operations; including initialization/helpers, fewer than 3,072
  reads/queries (<12 MiB), 1,024 writes (<4 MiB), plus one <=8-KiB charge and
  four small Workpool admissions. **One charge per mutation**.
- An axis page: `4 × (3 seeks + 4 summaries) + 3 final seeks = 31`
  aggregate queries, at most `31 × 2 × 12 × 4 = 2,976` bounded node reads
  (<=5.82 MiB at 2 KiB/node). Helpers remain below 4,096 queries.
- Seven days: `7 × 4 × 96 × 2 KiB = 5.25 MiB` bounded node reads.
- Thread total plus three four-group pages: a seek visits at most three depth
  paths (36 nodes); each axis uses `15 × 36 + 16 × 96 = 2,076` node reads.
  Total `(3 × 2076 + 4 × 96) × 2 KiB = 12.92 MiB`, plus <0.5 MiB helpers;
  fewer than 7,000 documents / 256 index queries, no writes.
- HTTP sink batches <=100 contain no transcript/request payload. They do not
  mutate 100 charges in a transaction. Acknowledgements update one <=8-KiB row.

All fake tests enforce Convex transaction limits. The maximum test constructs
valid 99,999-entry fixtures for **every projection**, spanning every status,
five maximum-byte labels and seven days. It admits the last real charge,
corrects/replaces/settles it at capacity with maximum UTF-8 fields and four
sinks, reads maximum subject and thread axis pages with continuation and seven
days, checks all totals, and proves that the next key is denied.

Source references used: Aggregate `src/client/index.ts:866-915`,
`src/component/btree.ts:120-138,216-225,333-415`; Workpool
`src/client/index.ts:95-120,576-579`; Agent 0.7.7
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
- The examples omit recording keys. Standalone calls require an explicit key
  because there is no core ToolContext/toolCallId in this PR.
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
