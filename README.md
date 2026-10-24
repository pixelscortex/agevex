# agevex

A Workflow-backed Convex component and host client for managed
`@convex-dev/agent` agents. Native Agent owns threads, messages, tools and
streaming. Agevex owns durable scheduling, authorization, depth-two delegation,
run budgets and idempotency.

Git-only, private package, **UNLICENSED**.

## Setup

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import agent from "@convex-dev/agent/convex.config";
import agevex from "agevex/convex.config";
const app = defineApp();
app.use(agent);
app.use(agevex);
export default app;
```

```ts
// convex/agents.ts
import { Agent, registerAgent } from "agevex";
import { components, internal } from "./_generated/api.js";

const researcher = new Agent(components.agent, {
  name: "Researcher",
  languageModel,
  subagents: [],
});
const main = new Agent(components.agent, {
  name: "Main",
  languageModel,
  subagents: [researcher],
});
const runtime = registerAgent(components.agevex, {
  agents: [main],
  refs: {
    runTurn: () => internal.agents.runTurn,
    coordinate: () => internal.agents.coordinate,
  },
  authorize: hostPolicy,
  authorizeExecution: hostExecutionPolicy,
});
export const { runTurn, coordinate } = runtime.internalFunctions();
export const {
  open,
  send,
  respond,
  answer,
  cancel,
  messages,
  streams,
  activity,
  delegations,
  runTree,
} = runtime.authorizedEndpoints();
```

`languageModel`, `hostPolicy` and `hostExecutionPolicy` are host-owned. For
Convex generated-reference inference cycles, annotate `runTurn` with
`RegisteredAction<"internal", TurnArgs, null>` and `coordinate` with
`RegisteredMutation<"internal", CoordinateArgs, CoordinateResult>` from
`convex/server`; the argument/result types are exported by `agevex`.
A root without children only needs `refs.runTurn`.

## Durable execution

`open({ agent, prompt, requestKey })` and
`send({ threadId, text, requestKey })` return typed receipts immediately: `{ status: "accepted", position, threadId,
assignmentId, receiptId }`, `{ status: "duplicate", position, threadId,
assignmentId, receiptId }`, or `{ status: "rejected", code }`. Position is the
zero-based inbox place at acceptance, including a reserved head until claim
consumes it; duplicates retain that original position.
Identical subject-scoped keys replay the receipt; changed input returns
`KEY_CONFLICT` before native writes. Invalid input, a full queue (`QUEUE_FULL`),
and recovery-required state also return rejections. Authorization failures throw. Up to 20 additional prompts queue while
busy. Arrivals never silently enter an ongoing turn.

Each thread has a component-internal loop workflow. It reads the durable
`inbox`, starts turn child workflows, then sleeps on `awaitEvent("ping")`.
Pings are doorbells; inbox rows own the work. Shared, batched reconciliation
checks idle loops every 30 seconds, recovering lost doorbells. Each turn runs
at most 16 slices,
one native model step per action. Paid work uses `maxRetries: 0` and
`retry: false`. Only ids and control values enter the workflow journal.

Root and child lanes have 2 and 4 slots respectively, within the starter
plan's 8 scheduled-job slots. Delegation returns immediately and releases the
parent action slot. Consecutive results from already-launched children batch
into one parent continuation. Every workflow carries a version argument;
step order is protected by replay fixtures.

A user prompt starts one run. Its turns and child results share a budget of
12 launches / 24 hops (launches, delivered results, questions and follow-ups). Result turns may
call `agevex_delegate` again. Over budget returns
`{ status: "denied", code: "RUN_BUDGET" }`. A root admits at most
5 active descendants by default and 4000 characters per delegated task.

Failures are sanitized and never automatically replayed. Ambiguous execution
sets `recovery_required`; the watchdog covers each active slice, excluding
queue and between-slice time.

## Hooks, notes and side agents

Hooks belong to an `Agent`: `beforeTurn`, `afterTurn`, `beforeTool`,
`afterTool`, and `beforeDelegate`. They receive trusted execution context and
return one `HookResult`: `note`, `block`, `input`, `output`, `continue`, or
`model`. They run inside the existing action; no Workflow steps are added.

```ts
const critic = new Agent(components.agent, {
  name: "Critic",
  languageModel,
  instructions: "Review the delta. Return a short note, or NONE.",
});
const main = new Agent(components.agent, {
  name: "Main",
  languageModel,
  hooks: {
    beforeTurn: (_hc, { prompt }) =>
      prompt.trim() ? undefined : { block: "A prompt is required." },
    afterTool: (_hc, { output }) => ({ output: redact(output) }),
  },
  sideAgents: [{ agent: critic, every: { turns: 3 }, sees: "delta" }],
});
```

`beforeTurn` can choose an allowlisted model only when `isRunStart` is true;
that choice persists for the agent's run. Concurrent siblings share the first
routing attempt. If its owner is denied, fails or is cancelled, siblings use
the committed model or their default; the classifier is never retried.
`afterTurn.continue` requests another
bounded turn (default 3 per run, hard maximum 8). A throwing hook fails the turn
with `HOOK_FAILED`; private details stay outside the transcript. Tool execution
hooks include native and `defineOnceTool` effects. The SDK's delegate, message
and ask protocols are excluded; delegation uses `beforeDelegate`. Provider-owned
executions and deferred host answers retain their native protocols: neither has
a local tool execution function to intercept inside the action.

Inside an authorized host mutation, call
`runtime.note(ctx, { threadId, text, from })`. It authorizes operation `note`
and throws a typed `NOTES_PENDING_LIMIT` error at capacity. Notes are escaped
user-role `<note from="…">` messages, capped at 4,000 characters.
`limits.notesPending` is the single admission cap (default 8, hard maximum 24),
independent of `queueLength`. Posted notes stay pending until the next turn claim with no decided approvals awaiting committed tool results (including denials); deferred answers commit their results atomically.
That claim saves all pending notes atomically in arrival order, after prior
tool results. Ordinary tool-step slices never drain notes. Notes never start a
turn or schedule work.

Notes and hook continuation prompts use the claimed request's native order
group, keeping future queued requests hidden without context injection.
The authorized `messages` reader adds `origin: user | result | note | continue`,
`from` for notes and `runId` for results. Unclassified native messages (including
assistant replies) use `user`. Page-local exact-id indexes add at most 201 small
metadata reads (532 KiB); total message reads remain below 8.27 MiB.
`delegations` and `runTree` include `side: boolean` for every public run.

Side cadence uses completed turns or `{ minutes: N }` since the last review,
checked after a turn without a cron. Deltas use exact recorded native ids and
orders: at most 24 recent messages and 48 KiB of text, with tool output stripped.
Skipped reviews retain their delta. Side runs use the child lane and root run
attribution, with a separate cap of 2 per run (hard maximum 8). Their replies
become passive notes; empty replies and `NONE` add nothing. Side runs never
hold a parent's settlement fence, never fail their parent, and cancel with the
root. Side agents keep their own configured model; root model overrides do not
apply to them. Their threads use the same authorized `messages` reader as other children.

## Optional module slots

Pass `usage`, `budget`, `telemetry`, `sandbox`, or `extract` to `registerAgent`.
Core imports only the contracts in `src/client/slots.ts`; module adapters belong
in their own packages. Omitted slots ignore usage, allow spending, export no
telemetry, add no sandbox tools, and pass files as native model parts.

Every managed tool receives a `ToolContext` through AI SDK `options.context`.
Native `createTool` also receives these facts on its normal injected context;
`defineOnceTool` receives them as its second argument. Facts include `subject`,
`rootThreadId`, `threadId`, the shared user `runId`, `agent`, `toolCallId`,
`signal`, and `meter`. The meter is always present. Charge keys hash the
tool-call identity and ordinal; operations hash the charge, method and ordinal.
Explicit keys distinguish logical operations when necessary. Model usage is
recorded once per saved step with exact native thread/message/step ids;
recording failures never replay or fail the generation.

Budget `check(ctx, { subject, runId })` runs before each slice. A denial ends
with `BUDGET_EXCEEDED` in activity and a passive thread note admitted under
the same `notesPending` cap as host and sandbox notes. Notes remain inbox
text until the next safe turn claim saves them natively. If the cap is full,
the budget notice is omitted, existing notes wait for that claim, and the typed
`BUDGET_EXCEEDED` still stops the turn; notices never displace notes or bypass
admission. Pair this with the host's copied `continue-budget` registry tool:
obtain explicit spending consent, update host budget policy, cancel the stopped
run to clear its recovery state, and send a fresh request, all in one host
mutation. `activity.runId` names the stopped run (the same id the budget check
received), so the fresh request key can be derived from it. Cancellation
discards that run's pending notes. Core never resumes an uncertain paid step.

Semantic slot facts (subject, agent, root/thread/run ids) are nonempty and at most
128 UTF-8 bytes (`LIMITS.factBytes`); invalid registration/endpoint facts throw a
typed `ConvexError`. Opaque keys use full SHA-256 hex (64 ASCII bytes) over
canonical, domain-separated parts, including explicit meter keys and once-tool
keys. Replay produces the same key; original semantic facts stay in attribution.
`tc.toolCallId` is bounded the same way; `tc.nativeToolCallId` retains the provider id.

Telemetry integrations receive all turn facts plus `turnKey` (hashed slice identity).
`flush(facts, signal)` receives that same identity, so an adapter can create a
separate action-scoped buffer for each turn and discard it after export. Flush
runs in `finally`, fails open, and is bounded to three seconds even when an
exporter ignores abort. Sandbox tools require both a slot and agent option
`sandbox: true`. Connect a sandbox module's trusted `onComplete` mutation to
`runtime.sandboxComplete(ctx, event)`; it authorizes background operation
`sandbox` against the stored owner and posts a bounded passive note. Both idle
and in-flight notes wait for the next safe turn claim; ordinary tool-step slices
never deliver notes. A full shared `notesPending` cap throws typed
`NOTES_PENDING_LIMIT`, just like host notes.
Saved budget and sandbox messages expose `origin: "note"` and `from: "budget"`
or `from: "sandbox"` through `messages`; passive notes never consume ready-work capacity.

## File attachments

`open` and `send` accept `files?: string[]`: at most eight distinct native Agent
`storeFile` file ids. Agent 0.7.7 has no uploader ownership field. In the host's
**trusted upload path**, attest the subject with
`runtime.registerFile(mutationCtx, { agent, fileId, subject })` after storing on
that subject's behalf. Never expose this helper as a public arbitrary-id claim.
A deduplicated native file may have separate grants for several uploaders.

Admission rejects unregistered/foreign files and records exact native message
attachment ids atomically with saving the message. Ownership facts use tagged
rows of the existing receipts ledger, excluded from effect-receipt TTL cleanup.
File bytes, metadata and refcounts remain native. Admission reads actual storage
sizes and rejects totals over `limits.attachmentBytes` (default 8 MiB, hard max
16 MiB) per message with `{ status: "rejected", code: "ATTACHMENT_LIMIT" }`.
Native downloads stream under the same per-generation budget, including history;
overflow stops before the model call and ends the turn with `GENERATION_FAILED`.
`runtime.fileAttached(ctx, { subject, threadId, fileId })`
provides an indexed exact-attachment check for an extract adapter's authorized
host callback; the helper itself is server-only. Without extract, files reach
the model as native file parts. With extract, the first slice admits one durable
extraction per attached file and adds the slot's thread-bound file tools.
Extraction owns its own deduplication, status and reads.

## Structured tasks

```ts
import { defineTask, runTask } from "agevex";
const classify = defineTask({
  name: "classify",
  input: z.object({ text: z.string() }),
  output: z.object({ category: z.string() }),
  prompt: ({ text }) => `Classify: ${text}`,
  model: languageModel,
  repair: 1,
});
// Inside a managed hook: component, attribution, usage and fence are inherited.
const result = await runTask(hc, classify, { text });
// Inside an authorized host action: supply trusted attribution explicitly.
const hostResult = await runtime.runTask(ctx, classify, { text }, { key, attribution });
```

Standalone `runTask(ctx, ...)` accepts `component`, `attribution`, and optional
`usage` in its options. Hooks default to a key derived from run + turn + task
name: replay in that turn reuses the result; another turn/run gets a fresh one.
Supply explicit keys for multiple distinct calls to the same task in one turn.
Explicit keys are scoped to subject + thread + task name, so host actions must
include the run/turn identity when they want a fresh result. Tasks use AI SDK
`generateText({ output: Output.object({ schema }) })` with no transport
retries, one repair re-ask for invalid output by default (`repair: 0` disables
it), and the core receipts ledger. Results are `{ status: "done", value }`,
`{ status: "failed", code }`, `{ status: "running" | "unknown" }`, or a typed
key/cancellation denial. Replays return the stored result; expired leases and
uncertain transport outcomes remain `unknown` and never run again. Results fit
64 KiB; use storage ids for larger artifacts. Each paid attempt records usage
when configured. Tasks add no Workflow steps or tables.

## Delegation

Agents may delegate two edges deep: Main → Builder → Reviewer. Set
`limits.maxDepth: 1` to lower this; cycles and deeper graphs fail at
registration. Shared child Agent objects are supported. Launch/hop budgets and
cancellation cover every descendant; results return to the immediate parent.

Parents receive `agevex_delegate({ agent, task, group?, wait? })` and
`agevex_message_child({ runId, text })`. Default `wait: "each"` delivers each
settled result immediately. With `wait: "all"`, a group
wakes its parent once after the launching slice ends and every member settles,
including failures. Membership seals when that slice ends; later launches into
the group return `GROUP_CLOSED`. Groups belong to one parent assignment and user run.
A group has at most `activeChildrenPerRoot` members (hard maximum 15);
omitting its name selects the unnamed group. Names are at most 200 characters.

Children receive `agevex_ask_parent({ question })`: one open question pauses
the child as `asking`, and its verified question wakes its parent immediately,
even inside a waiting group. The parent answers with `agevex_message_child`.
Follow-ups reach running or idle children in the same root; finished or foreign
runs return typed denials. Each child accepts 4 follow-ups by default (maximum
8); questions and follow-ups spend the originating run's hops. Both use the
task-length bound. Asking children remain cancellable; one inbox slot is
reserved for their answer.

R1: The inbox holds ready work in FIFO order; claims coalesce consecutive head rows.
R2: `ask_parent` denies `ASK_WITH_CHILDREN` while any descendant is non-terminal.
R3: Runs settle after the last turn ends, descendants settle, and the inbox empties.

The verified run result is the final text of the last turn before settlement;
earlier final text while descendants are running does not finish the run.

`runTree({ threadId })` is an owner-authorized, root-only query returning the
current request's descendants with agent, status, depth, group, parent
assignment, native child thread and timings. Its full-history read is bounded
by `runLaunches` (maximum 50); the active descendant cap remains 15.

## Cancellation and approvals

`cancel({ threadId })` is owner-authorized and root-only. It increments the
epoch, cancels root/child workflows and clears queued work. Running actions
poll about once a second and abort their signal. Native and managed-tool
mutations check execution id plus epoch atomically; late writes are dropped.
after cancel, the SDK refuses new nested calls and drops its own writes; writes your own code makes inside an already-running nested action are yours to guard with `tc.signal`.
A fresh `send` can start new work after cancellation. External effects already
accepted by a provider still depend on that provider's abort behavior.

At the hard maximum of 15 descendants, cancel covers 16 assignments, up to
1,632 ready rows and 384 pending notes. Its read bound is 12,680 KiB of
16,384 KiB (22.6% headroom), including routing owner reads and patches.

Pending native tool approvals block generation and leave the inbox row
waiting, avoiding Agent 0.7.7's automatic denial on a new generation.
Approval responses must go through `respond({ threadId, approvalId, approved, reason? })`; a response saved directly through the Agent component is not seen by the runtime. `respond` and `answer` return `{ messageId, replayed }`: an identical retry replays the original `messageId` with `replayed: true`, so a host can record single-use effects (such as spending consent) only for the first decision.

## Effects that must run once

```ts
import { defineOnceTool } from "agevex";
import { z } from "zod";

const charge = defineOnceTool({
  name: "charge",
  input: z.object({ orderId: z.string() }),
  key: (input) => input.orderId, // defaults to the native toolCallId
  run: (input, tc) =>
    hostCharge(input.orderId, {
      subject: tc.subject,
      signal: tc.signal,
    }),
});
```

Add the tool to the Agent's `tools`. Its context contains `ctx`, `subject`,
`threadId`, `runId`, `toolCallId` and `signal`. Tools own their permissions.
The receipts ledger fingerprints inputs and caches bounded results. Reused
keys with different input return `KEY_CONFLICT`; expired 10-minute leases
become `unknown`, with no silent rerun. Declare `repeatSafe: true` only when
repeating an abandoned effect is safe. `leaseMs` overrides the lease. Results
must fit 64 KiB; return a storage reference for larger payloads. Expired
receipts are purged in scheduled batches after seven days.

## Reads, policy and limits

`messages({ threadId, paginationOpts })` returns only the native message page.
`streams({ threadId, streamArgs })` returns `{ streams }` with native stream sync.
Both queries authorize root and child ownership independently. Hosts using a
`useThreadMessages`-style integration subscribe to the page query and the stream
query separately, then merge deltas with the persisted page on the client; do
not call both from one server query (that shares one transaction budget).
Messages budget: 0.5 MiB page + 1 MiB overshoot + six 1 MiB prefetched heads +
0.25 MiB coordination = 7.75 MiB. Stream delta budget: two 1 MiB metadata docs +
8 MiB native deltas + 1 MiB overshoot + 0.25 MiB coordination = 11.25 MiB.
Agent's `kind: "list"` retains the upstream 100-row metadata bound (§9b); its
reader has no byte cap. Find `childThreadId` in `delegations`.
`activity`, `delegations` and `runTree` are root coordination reads. Public sends and
cancels cannot drive a child's lifecycle.

`authorize` checks public ownership and background `delegate`/`deliver`
operations. Background calls may have no authenticated connection: recheck the
stored subject against current host policy. `authorizeExecution` runs before
every model slice. Optional `observe` receives metadata-only lifecycle events;
observer failures do not change execution.

`LIMITS`, exported from `agevex`, is the single source of runtime bounds,
including lane sizes, model output/deadline, slices, run budgets, queue size,
ledger retention. Registration accepts `limits?: Partial<Limits>` for lanes,
depth, run budgets, active descendants, follow-ups per child, task/queue size,
slices and lease; positive
integers are required and lanes must fit scheduled concurrency. Registrations
sharing a component mount share its lane capacities. `PLATFORM` contains
documented facts, not checked by the SDK, including Workflow journal/step
ceilings (8 MiB / 800 KiB). Workflow enforces those byte limits.

## Registry tools

Copy headless tools into your host with shadcn. Start the docs site in
`docs/site`, then install from its origin:

```sh
bunx shadcn add http://localhost:3000/r/todo.json
```

Items: [todo](docs/site/content/docs/tools/todo.mdx) (100 items, 32 KiB/list),
[goals](docs/site/content/docs/tools/goals.mdx) (one 4000-character goal/run),
[ask-user](docs/site/content/docs/tools/ask-user.mdx) and
[continue-budget](docs/site/content/docs/tools/continue-budget.mdx) (native
approval, 2000 characters). Todo/goals ship host table snippets to merge into
your schema; approval items add no tables. Core `ToolContext` supplies ownership
and the once-tool ledger. Keep state functions internal and answer approvals
through core `respond`. Approved reasons are not model-visible; send a separate
message for freeform answers. Budget consent does not change a budget.

`bun run registry:build` rebuilds `/r/*.json`; `bun run test:tools` builds the
package and runs the offline suite, including a CLI install smoke test that
clearly skips if shadcn needs network. The provisional `@agevex` namespace
requires a host registry URL configuration.

## Development

```sh
bun install --frozen-lockfile
bun run test                  # scripted models, no network
bun run test:live             # skips without OPENROUTER_API_KEY
bun run check
bun run typecheck
bun run typecheck:tests
bun run build
```

Live tests request `openrouter/free` with the ordered OpenRouter fallback
`["openrouter/free", "minimax/minimax-m3.1-flash"]`, a small request bound and a
default $0.05 spend cap (`OPENROUTER_LIVE_MAX_USD`). Each response records its
actual routed model, tokens and provider cost. Results are saved
in `.vite-plus/live-results.json`. `agevex/test` exports `register`,
`scriptedModel` and `expectJournalUnchanged`; the latter checks committed
journals and replays them through the real Workflow engine.

See [component ownership](src/component/README.md). Deferred: depth above two,
peer messaging, approval UX, hooks, meter and other optional modules. Existing
v1 Workflow step order is preserved; new delegation fields are optional on
persisted v1 rows.

`open` and `send` accept `models: { Main: "model-id", Researcher: "model-id" }`.
Register `modelAllowlist: ["model-id"]` and `models: id => provider.chat(id)`.
Only registered reachable agent names and allowed model ids are accepted. Each
accepted user prompt starts a run with an immutable model snapshot, shared by
all its descendant and result turns. A later send updates the next run only;
omitting `models` inherits the last accepted thread policy; `{}` restores Agent
defaults. Maps have at most 8 entries and 512 Convex-encoded bytes (ids ≤200
characters), keeping cancel's per-run read budget at 1 KiB.

Tools declared without `execute` use Agent's native deferred results. The owner
calls `answer({ threadId, toolCallId, text })` to save a native text tool result
and resume when all pending calls have answers. `answer` also supports owned
child threads and rejects unrecorded, foreign, cancelled, or already answered
calls. Text is non-empty and ≤16,000 UTF-16 units. Mixed approvals and deferred
calls share the 16-call pause bound; `respond` handles approval decisions and
`answer` handles free text. Cancel settles only open recorded calls with native
execution-denied results. Payloads remain in Agent storage; coordination stores
only hashed call ids and exact message references.

A fresh send reopens a cancelled thread, preserving the existing cancellation
contract. Failed cancellation cleanup blocks reopening with a typed `CANCELLED`
receipt until a subsequent cancel successfully settles the recorded work.
