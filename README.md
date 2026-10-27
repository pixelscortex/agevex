# agevex

A Workflow-backed Convex component and host client for managed
`@convex-dev/agent` agents. Native Agent owns threads, messages, tools and
streaming. Agevex owns durable scheduling, authorization, depth-two delegation,
run budgets and idempotency.

Git-only, private package, **UNLICENSED**.

## Source layout

Core lives in `src/component/` and `src/client/`. Optional modules live in
`src/modules/<name>/`: `component/` runs inside Convex, `client/` is the host API,
`shared/` contains pure contracts used by both, and `test.ts` registers tests.
Telemetry is a small host adapter; tools export the stateless `ask_user` factory. Each module README maps its files. Package subpaths stay `agevex/<name>`,
with `/convex.config`, `/test` and `/_generated/component.js` for components.

## React hooks

`agevex/react` provides headless hooks over your app’s authorized public refs,
using its existing ConvexProvider/auth. Messages use explicit pagination and a
500-message window; decisions wait for server receipts. See
[React hooks](docs/site/content/docs/concepts/react-hooks.mdx) and the
[Main → Builder → Reviewer guide](docs/site/content/docs/concepts/main-builder-reviewer.mdx).

## Development commands

Use Bun for all commands. `bun run check` checks formatting, lint, library/test
types, the Convex lint gate and docs types. `bun run fmt` applies Oxfmt;
`bun run fmt:check` and `bun run lint` are the individual gates.
`bun run test` runs the offline suite with two workers and no build.
`bun run test:live` uses the opt-in provider keys in the main checkout.

## Run policy

Set `run` on each `new Agent(native, options)`:
`{ mode: "generate", maxOutputTokens: 2048, modelTimeoutMs: 45_000, toolTimeoutMs: 15_000, stepsPerTurn: 6 }`.
Defaults are streaming, 4,096 tokens, separate 90-second model/tool deadlines,
and 16 steps (one model call per action). Bounds are 1–32,768 tokens,
1,000–300,000 ms per deadline and 1–64 steps. The combined watchdog budget
`modelTimeoutMs + 16 * toolTimeoutMs + 60_000` must fit 30 minutes.
Native generate saves messages, usage, tools and approvals without deltas.
Run `runTurn` in the default Convex runtime, never a `"use node"` module
(the Node action limit is ten minutes). 32k output tokens may require a longer
model timeout. The client slice has a five-minute cap and the server watchdog
allows another 30 seconds for clean timeout finalization.
At most 16 new model tool calls execute serially per slice; approval resumes
do not consume that allowance; timeouts fence late managed writes
and never retry unknown effects. Settings are fixed at request acceptance and
shared by children; registration changes affect new runs.

Existing registration `limits.rootLane / childLane` default to 2 / 4,
maximum 4 / 4 (8 total slots). All registrations sharing a mount must agree;
sleeping workflows use no slot. See
[the runtime contract](docs/site/content/docs/concepts/runtime.mdx).

## Usage and budgets

The usage hook reports each saved model step to your app's ledger, including
its exact native message id, provider response id and token usage. The budget
hook reads your own spend before each step or local tool. Helpers at
`agevex/usage` estimate token cost and fetch a real OpenRouter generation cost.
See [Recording usage in your app](docs/site/content/docs/concepts/recording-usage.mdx).

## Optional sandboxes

`agevex/sandbox` binds a provider sandbox to trusted thread, run or subject
facts. Models never supply sandbox IDs. Mount `agevex/sandbox/convex.config`
separately; core does not import it.

```ts
// convex/convex.config.ts — in addition to Agent and agevex
import sandbox from "agevex/sandbox/convex.config";
import daytona from "@daytona/convex/convex.config";
// Declare DAYTONA_API_KEY in defineApp({ env: { DAYTONA_API_KEY: v.string() } }).
app.use(sandbox);
app.use(daytona, { env: { DAYTONA_API_KEY: app.env.DAYTONA_API_KEY } });
```

```ts
import { defineSandbox, daytona } from "agevex/sandbox";

const sandbox = defineSandbox({
  component: components.sandbox,
  provider: daytona(components.daytona, { autoStopInterval: 0 }),
  scope: "thread",
  agent: components.agent, // native Agent storeFile for exports
  authorize: hostSandboxPolicy,
  refs: {
    wake: () => internal.sandboxes.wake, // scheduled mutation: claims, then schedules poll
    poll: () => internal.sandboxes.poll,
    settle: () => internal.sandboxes.settle,
    cleanup: () => internal.sandboxes.cleanup,
  },
  onComplete: async (ctx, event) => {
    // Record a host event or workflow.sendEvent here, in this mutation.
    await hostJobCompleted(ctx, event);
  },
  usage: { record: hostSandboxObservation }, // optional; estimate-only
});
export const { wake, poll, settle, cleanup } = sandbox.internalFunctions();
const tools = sandbox.tools();
```

`hostSandboxPolicy(ctx, request)` must check current host policy and return
`{ subject }`. Requests name `use`, `export`, `stop`, `delete`, `poll` or
`cleanup`; scheduled operations have no end-user identity. A supplied subject
must match the policy result. Expose host endpoints that call these helpers,
not raw component references. For inference cycles, annotate exported host
functions with `RegisteredAction`/`RegisteredMutation` using exported
`PollArgs`, `PollActionArgs`, `SettleArgs` and `Record<string, never>` cleanup args.

The five tools are `sandbox_exec`, `sandbox_read_file`, `sandbox_write_file`,
`sandbox_list`, and `sandbox_run_background`. Effects use core's existing
`defineOnceTool` receipt binding. Pure reads take a trusted `ToolContext` in AI
SDK 7's `context`, or from `sandbox.tools(tc)` in a host-bound tool factory.
File contents do not enter core's 64 KiB receipts. Automatic core sandbox-slot
and event-wait wiring is a separate integration step.

Defaults: commands ≤180 seconds; total action work ≤540 seconds; shared
stdout/stderr tail ≤6,000 characters; text read/write ≤160,000 characters;
directory listing ≤100 entries; default-runtime binary export ≤8 MiB (hard maximum); 16 active jobs per
sandbox; idle TTL 24 hours. Host overrides are validated against hard maxima.
Daytona snapshots must include `python3` for bounded command output and reads.
Use `autoStopInterval: 0` when jobs must outlive the idle interval.

`sandbox.export(ctx, { threadId, path })` returns
`{ fileId, storageId, bytes, sha256 }` through native Agent `storeFile`.
Run-scoped exports require `resolveThread(ctx, threadId)` returning trusted
`{ subject, threadId, runId }` from host state. Export never creates a sandbox
for a missing binding. Read failures retain the existing filesystem.
Exports read windows of at most 512 KiB and hash incrementally before storing
one Blob. Daytona stages temporary windows for its file API so file bytes
never enter execution rows, component arguments or receipts. An interrupted
transfer creates no storage object.

For exports above 8 MiB, register a host action from a `"use node"` file:

```ts
// sandboxExports.ts
"use node";
import { sandboxNodeExport } from "agevex/sandbox";
import { sandboxOptions } from "./sandboxOptions";
export const exportFile = sandboxNodeExport(sandboxOptions);
```

Pass `nodeExport: internal.sandboxExports.exportFile` to `defineSandbox`.
Larger files then route to that action, which repeats authorization and trusted
scope resolution. Its `limits.exportBytesNode` defaults to a hard maximum of
64 MiB. Without this registration, oversized exports fail with
`SANDBOX_EXPORT_TOO_LARGE` naming `sandboxNodeExport()`. Both export bounds can
be lowered. Peak file allocations are conservatively 4× the limit: 32 MiB in
the default 64 MiB runtime, or 256 MiB in the 512 MiB Node runtime, plus bounded
transport windows and runtime overhead.

Background completion produces one atomic host callback with
`{ type: "sandbox.job.completed", jobId, providerJobId?, scopeKey, subject,
threadId, runId, state: "done" | "failed" | "unknown", exitCode?, logTail?, code? }`.
The provider job ID, sandbox ID and private job directory are persisted before
launch. Daytona detaches a process group through bounded synchronous execs;
the module owns polling and reads actual log tails at the source. The provider's
disposable VM supplies isolation: on completion and on deadline, every process still in the job's original process group is terminated; a process that deliberately detaches (setsid / daemonizes) is outside this guarantee; for full containment stop or delete the sandbox, which `sandbox.stop` / TTL cleanup do.
The supervisor retains the unreaped leader through SIGTERM and SIGKILL before
publishing completion. Cancellation uses an atomic control file; if the supervisor
does not acknowledge it, fallback signaling requires every current group member's
`AGEVEX_JOB` marker in `/proc`. Unverified ownership records `unknown` without
signaling. Group identity and completion files are published by atomic rename. Polls back
off and stop at completion or a bounded deadline. Expiry attempts a bounded
group kill and records `unknown` with `SANDBOX_JOB_DEADLINE`. Status failures
keep polling with backoff until the deadline. An `unknown` result first attempts
a bounded group kill; uncertain cancellation retains the deadline path. A lost
launch response stays `unknown`;
paid work is never replayed. A watchdog handles interrupted launch/poll
actions. Successful callbacks and terminal state commit together, so callbacks
must perform transactional writes rather than external effects. Callback
failures are retried only until the job deadline; then the job becomes `unknown`
and `sandbox.job(ctx, { jobId })` exposes its bounded reconciliation snapshot.
The scheduled `wake` is a mutation, so it runs exactly once: it claims the job
(scheduling the lease backstop) and then schedules the `poll` action; if that
action dies, the backstop retries it. Only a definite denial from
`authorize` counts as revoked background authority, which stops polling and
records `unknown` without calling the provider or the host callback. Exactly
these shapes are a denial: `new ConvexError("FORBIDDEN")`,
`new ConvexError({ code: "FORBIDDEN" })`, and an `Error` whose message starts
with `FORBIDDEN` or `SANDBOX_FORBIDDEN`. Any other error is transient: the job
is retried with the normal poll backoff. A persistent transient error ends the
job as `unknown` (`SANDBOX_JOB_DEADLINE`) without a kill and without a callback,
once the late-attempt limit after the deadline is reached. The marker kill for a
vanished job directory repeats up to three scan-and-kill passes; marked
processes left after that report not-killed. A job whose directory vanished is
`unknown` and is killed through its `AGEVEX_JOB` environment marker (no marked
process counts as killed).

Provider auto-delete is disabled. `sandbox.stop(tc)` preserves files and
resumes on next use, including stopped, archived and recoverable error states.
The host explicitly calls `sandbox.cleanup(ctx)` to schedule a finite TTL
sweep. Active jobs protect their filesystem; action leases conservatively
delay idle cleanup by up to nine minutes. A sweep stops and reschedules itself
when too little action budget remains to finish a delete. Uncertain deletes are
not retried. A deleted scope simply gets a fresh sandbox on next use. Lost
creates retain an unknown reservation instead of risking a duplicate resource;
after finding and deleting the possibly-created sandbox at the provider
(Daytona label `agevexScope`, equal to `sandbox.scopeKey(facts)`), the host
calls `sandbox.forget(ctx, facts)` to let the scope create again. A command that
exceeds its timeout returns exit 124 with `timedOut: true` (a command's own
exit 124 has `timedOut: false`) and its process group is killed; the timeout
leaves five seconds of the action budget for that kill. Exporting a deleted
scope is `SANDBOX_NOT_FOUND`. A watchdog
claimed after the deadline kills the group and notifies the host once with
`unknown` / `SANDBOX_JOB_DEADLINE`; only if two such attempts (counted on the job) both die unsettled
does the next wake end the job as `unknown` without a callback.

`agevex/test` and `agevex/sandbox/test` export `fakeSandboxProvider`; `agevex/sandbox/test` also registers the
optional component with convex-test. `bun run test` is offline. The sandbox
live suite is included in `bun run test:live`, gated by `DAYTONA_API_KEY`, and
always deletes its sandbox in `finally`.

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
    textTask: () => internal.agents.textTask,
  },
  authorize: hostPolicy,
  authorizeExecution: hostExecutionPolicy,
});
export const { runTurn, coordinate, textTask } = runtime.internalFunctions();
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
  title,
  rename,
} = runtime.authorizedEndpoints();
```

`languageModel`, `hostPolicy` and `hostExecutionPolicy` are host-owned. For
Convex generated-reference inference cycles, annotate `runTurn` with
`RegisteredAction<"internal", TurnArgs, null>` and `coordinate` with
`RegisteredMutation<"internal", CoordinateArgs, CoordinateResult>` from
`convex/server`; the argument/result types are exported by `agevex`.
A root without children needs `refs.runTurn` and `refs.textTask` by default.
Set `title: false` to omit `refs.textTask`.
Annotate its export with `RegisteredAction<"internal", TextTaskArgs, null>`
when generated-reference inference needs an explicit type.

## Background titles

Titles generate once after the first accepted message, using the root model.
Configure `title: { model, prompt, maxOutputTokens }` or `title: false`.
Export `textTask` and provide `refs.textTask` when enabled. The default output
cap is 128 tokens, with a hard maximum of 4,096. App/user native titles always
win over late generation, including cancellation. Jobs recheck authorization
and budget, run without tools or repairs, and never retry uncertain paid work.
Usage failures mark the run partial. See [titles](docs/site/content/docs/concepts/background-text.mdx).

Apps can build [summaries with Convex Agent](docs/site/content/docs/concepts/agent-summaries.mdx).

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
12 launches / 24 hops (launches, delivered results, notes, questions, answers and
follow-ups). Each launch reserves its result's hop; each question reserves its
answer hop. Notes, questions and follow-ups cannot spend those reserved hops.
Final results always enter the ready queue, even above
`queueLength`. The queue limit applies to messages: user sends, parent notes,
questions and child follow-ups are refused at capacity (`QUEUE_FULL` for user
sends, `QUEUE_LIMIT` for component enqueues). Answers and approval continuations
retain their control allowance. Messages are refused until the queue drains
below its limit. Launch admission also caps outstanding result work per assignment
at `runLaunches` across user requests: pending results, unreleased join members
and queued result rows. Delivery replaces a pending result; claim frees this
capacity. Reaching this separate bound returns `RESULTS_PENDING`: wait for or claim
child results before launching more. `RUN_BUDGET` means a launch or hop budget is
exhausted. Result turns may call
`agevex_delegate` again. A root admits at most
5 active descendants by default and 4000 characters per delegated task.

Failures are sanitized and never automatically replayed. Ambiguous execution
sets `recovery_required`; the watchdog covers each active slice, excluding
queue and between-slice time.

## Hooks and notes

Hooks belong to an `Agent`: `beforeTurn`, `afterTurn`, `beforeTool`,
`afterTool`, and `beforeDelegate`. They receive trusted execution context and
return `note`, `block`, `input`, `output` or `model` where appropriate.
`afterTurn(hc, { turn, text, messageIds })` is a notification returning void.
Hooks run inside the existing action; no Workflow steps are added.

```ts
const main = new Agent(components.agent, {
  name: "Main",
  languageModel,
  hooks: {
    beforeTurn: (_hc, { prompt }) =>
      prompt.trim() ? undefined : { block: "A prompt is required." },
    afterTool: (_hc, { output }) => ({ output: redact(output) }),
  },
});
```

`beforeTurn` runs before each model generation, including tool steps and approval
resumes. Its allowlisted `model` applies to that invocation only. Return it every
time to keep using it; concurrent siblings choose independently. No hook choice
is stored. `afterTurn` cannot request more work; use the public send/runtime API
from your own code for a follow-up. A throwing hook fails the turn
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

Notes use the claimed request's native order
group, keeping future queued requests hidden without context injection.
The authorized `messages` reader adds `origin: user | result | note`,
`from` for notes and `runId` for results. Unclassified native messages (including
assistant replies) use `user`. Page-local exact-id indexes add at most 201 small
metadata reads (532 KiB); total message reads remain below 8.27 MiB.

## Optional module slots

Pass `usage`, `budget`, `telemetry`, or `sandbox` to `registerAgent`.
Core imports only the contracts in `src/client/slots.ts`; module adapters belong
in their own packages. Omitted slots ignore usage, allow spending, export no
telemetry, add no sandbox tools, and pass files as native model parts.

Every managed tool receives a `ToolContext` through AI SDK `options.context`.
Native `createTool` also receives these facts on its normal injected context;
`defineOnceTool` receives them as its second argument. Facts include `subject`,
`rootThreadId`, `threadId`, the shared user `runId`, `agent`, `toolCallId`,
`signal` and the trusted `promptMessageId`. Model usage is reported once per
saved step with the exact native message id; hook failures mark usage partial
and never replay or fail the generation. Apps own tool-cost recording.

Budget `check(ctx, { subject, runId })` runs before each slice. A denial ends
with `BUDGET_EXCEEDED` in activity and a passive thread note admitted under
the same `notesPending` cap as host and sandbox notes. Notes remain inbox
text until the next safe turn claim saves them natively. If the cap is full,
the budget notice is omitted, existing notes wait for that claim, and the typed
`BUDGET_EXCEEDED` still stops the turn; notices never displace notes or bypass
admission. Use the [budget consent recipe](docs/site/content/docs/tools/raise-budget.mdx):
obtain explicit spending consent, update host budget policy, cancel the stopped
run to clear its recovery state, and send a fresh request, all in one host
mutation. `activity.runId` names the stopped run (the same id the budget check
received), so the fresh request key can be derived from it. Cancellation
discards that run's pending notes. Core never resumes an uncertain paid step.

Semantic slot facts (subject, agent, root/thread/run ids) are nonempty and at most
128 UTF-8 bytes (`LIMITS.factBytes`); invalid registration/endpoint facts throw a
typed `ConvexError`. Opaque keys use full SHA-256 hex (64 ASCII bytes) over
canonical, domain-separated parts, including usage keys and once-tool
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
provides an indexed exact-attachment check for authorized host tools. Files
reach the model as native file parts; attachment content remains in native storage.

## Structured tasks

```ts
import { defineTask, runTask } from "agevex";
const classify = defineTask({
  name: "classify",
  input: z.object({ text: z.string() }),
  output: z.object({ category: z.string() }),
  instructions: "You label support messages.", // optional system message
  prompt: ({ text }) => `Classify: ${text}`,
  model: languageModel,
  repair: 1,
});
// Inside a managed hook: component, attribution, usage and fence are inherited.
const result = await runTask(hc, classify, { text });
// Inside an authorized host action: supply trusted attribution explicitly.
const hostResult = await runtime.runTask(ctx, classify, { text }, { key, attribution });
```

`instructions` (a string or `(input) => string`) is sent as the model's system
message, while `prompt` stays the user message. It is bounded like the prompt
(non-empty, within `maxPromptLength`), is part of the receipt payload
fingerprint, and repair re-asks reuse it unchanged. Omit it and no system
message is sent.

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

Parents receive `agevex_delegate({ agent, task, wait?: "each" })` and
`agevex_message_child({ runId, text })`. Default `wait: "each"` delivers each
settled result independently.

Children receive `agevex_ask_parent({ question })`: one open question pauses
the child as `asking`, and its verified question wakes its parent immediately,
The parent answers with `agevex_message_child`.
Follow-ups reach running or idle children in the same root; finished or foreign
runs return typed denials. Each child accepts 4 follow-ups by default (maximum
8); questions and follow-ups spend the originating run's hops. Both use the
task-length bound. Asking children remain cancellable; one inbox slot is
reserved for their answer.

Children also receive `agevex_message_parent({ text })` to report progress and
keep working. It returns `{ status: "accepted", messageId }` or a typed denial.
Notes wake a sleeping parent at its next safe
turn without bypassing approval or deferred calls. Inbox commit order is FIFO:
accepted notes precede that child's final result, and consecutive work may
share a turn. Identical tool-call retries replay without another save or wake.
Text fits 2 KiB encoded; each child can send 4 notes by default (8 maximum,
`limits.parentNotesPerChild`), at least 5 seconds apart. Each fresh note spends
one hop and one ready queue slot. Size, rate, count, hop and queue denials save
nothing. Finished/cancelled children cannot send; committed notes remain in
history. Woken turns record usage through the usual slot. `runtime.note` stays
passive and does not wake a turn.

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

Human decisions use `respond({ threadId, approvalId, decision })`:
`{ kind: "approve" }`, `{ kind: "reject", reason? }`, or
`{ kind: "approve", edit: { input } }`. Only local tools explicitly opting into
`approval: { editable: true }` can be edited; provider-executed and deferred tools cannot. The host
validates edited input with the registered tool schema in the response transaction.
Invalid edits leave the request pending. `defineOnceTool({ approval: { editable: true }, ... })`
also enables approval without separately setting `needsApproval`.

An edited approval preserves the original native proposal. A receipt binds the
exact tool call to effective input and original/effective hashes. The native approval
response carries this audit annotation in its reason, and the native result is
`{ result, approval: { toolCallId, input, originalHash, effectiveHash, edited } }`.
Hooks and the once-tool fingerprint see the effective input; `beforeTool` may deny
work, but rewriting approved input returns `APPROVED_INPUT_CHANGED`. Cancellation
and current host execution authorization still apply. No paid effect is retried.

`pendingApprovals({ threadId, rootRunId? })` authorizes the root and includes its
current owned child decisions. Each item contains `id`, `toolCallId`, `threadId`,
`agent`, `kind` (`approval` or `ask`), `tool`, `input`, `editable`,
`providerExecuted`, and optional `question`/`schema`. The optional run selector
must match the root's current request. Subscribe to this query to render controls.

Bounds are shared: 16 calls per paused assignment, 16 paused assignments, 16 KiB
per input/answer, 8 KiB per form schema, 16 KiB per projected item and
4 MiB per pending query output. Compact proposals (≤32 KiB) live in the existing
receipts table beside exact native references, keeping reasoning messages out of
pending reads. Oversized input commits a typed `APPROVAL_LIMIT` refusal. An item
whose projection exceeds 16 KiB becomes a bounded `truncated: true` stub, allowing
other decisions to remain visible; truncated asks refuse answers with
`PROPOSAL_TRUNCATED`. Factory asks check input, schema, identifiers, and projection
envelope before saving: exceeding the combined item bound returns `ASK_TOO_LARGE`
to the model without a pending item. Proposals last until answer, execution or
cancellation consumes their reference. Decisions and answers retain the seven-day response
receipt: identical retries return the first `{ messageId, replayed: true }`, and
changed payloads return `KEY_CONFLICT`.

`cancel({ threadId })` is owner-authorized and root-only. It increments the
epoch, cancels root/child workflows and clears queued work. Running actions
poll about once a second and abort their signal. Native and managed-tool
mutations check execution id plus epoch atomically; late writes are dropped.
after cancel, the SDK refuses new nested calls and drops its own writes; writes your own code makes inside an already-running nested action are yours to guard with `tc.signal`.
A fresh `send` can start new work after cancellation. External effects already
accepted by a provider still depend on that provider's abort behavior.

At the hard maximum of 15 descendants, cancel covers 16 assignments, up to
2,432 ready rows (`16 × (100 messages + 50 results + 2 control rows)`) and
384 pending notes. Cancel deduplicates up to 168 request budgets. Its conservative
read bound is 14,100 KiB of 16,384 KiB; written bytes stay within 10,508 KiB.
Native message bodies are cleaned separately.

Pending native tool approvals block generation and leave the inbox row
waiting, avoiding Agent 0.7.7's automatic denial on a new generation.
Approval responses must go through `respond({ threadId, approvalId, decision })`; a response saved directly through the Agent component is not seen by the runtime. `respond` and `answer` return `{ messageId, replayed }`: an identical retry replays the original `messageId` with `replayed: true`, so a host can record single-use effects (such as spending consent) only for the first decision.

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

For `open` and `send`, `authorize` runs first on every call, including
retries, and returns the host's `{ subject }` mapping. It also receives
`requestKey`; no identity-subject equality or replay flag is required. Retained
receipts are then resolved privately for that subject: identical input returns
`duplicate`, changed input returns `KEY_CONFLICT`, and neither calls `admit`.

Optional registration hook `admit(ctx, { subject, operation, agent, threadId?, requestKey })`
lets hosts refuse new paid work (e.g. exhausted balance) without breaking
idempotent retries:

```ts
admit: async (ctx, { subject }) => {
  if (!(await hasBalance(ctx, subject))) throw new Error("OUT_OF_BALANCE");
},
```

All agevex checks that can return a rejection receipt, including input, queue
and attachment limits, run before `admit`. It receives the full host MutationCtx:
**admit may write host state in the same transaction; those writes commit only
if the request is accepted.** Native saves, inbox and receipt writes follow the
hook. A thrown refusal or later failure rolls the entire mutation back; any
non-accepting result after the hook throws. No reservation or settlement
counterpart is required. Authorization can still deny any retry.

`LIMITS`, exported from `agevex`, is the single source of runtime bounds,
including lane sizes, model output/deadline, slices, run budgets, queue size,
ledger retention. Registration accepts `limits?: Partial<Limits>` for lanes,
depth, run budgets, active descendants, follow-ups per child, task/queue size,
slices and lease; positive
integers are required and lanes must fit scheduled concurrency. Registrations
sharing a component mount share its lane capacities. `PLATFORM` contains
documented facts, not checked by the SDK, including Workflow journal/step
ceilings (8 MiB / 800 KiB). Workflow enforces those byte limits.

## Ask the user

```ts
import { createAskUserTool } from "agevex/tools";
const tools = { ask_user: createAskUserTool() };
```

This deferred tool pauses until the owner calls core `answer`. It supports
bounded questions and structured forms without extra tables or installation.
See [ask_user](docs/site/content/docs/tools/ask-user.mdx) and
[Asking the user to raise a budget](docs/site/content/docs/tools/raise-budget.mdx).

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
peer messaging, approval UX, hooks and other optional modules. Existing
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
calls `answer({ threadId, toolCallId, value })` to save a native JSON tool result
and resume when all pending calls have answers. `answer` also supports owned
child threads and rejects unrecorded, foreign, cancelled, or already answered
calls. Without a form schema, value must be a nonblank string. Answers are ≤16 KiB
(encoded JSON and Convex bytes). Mixed approvals and deferred
calls share the 16-call pause bound; `respond` handles approval decisions and
`answer` handles validated JSON. Cancel settles only open recorded calls with native
execution-denied results. Agent owns the original messages; coordination stores
hashed call ids, exact message references and references to compact proposals.

A fresh send reopens a cancelled thread, preserving the existing cancellation
contract. Failed cancellation cleanup blocks reopening with a typed `CANCELLED`
receipt until a subsequent cancel successfully settles the recorded work.

## Telemetry

`agevex/telemetry` adapts a host-supplied AI SDK 7 integration:

```ts
import { telemetry } from "agevex/telemetry";
import type { Telemetry } from "ai";

export function telemetrySlot(integration: Telemetry, flush: () => Promise<void>) {
  return telemetry({ integration, flush });
}
// registerAgent(components.agevex, { ...registration, telemetry: telemetrySlot(...) })
```

`integration` may also be a synchronous factory receiving trusted run, thread,
subject, agent and turn facts. Callbacks receive the same frozen facts as
`event.agevex`. Callback and flush failures are isolated; execution wrappers
cannot repeat model/tool work. Core bounds final flushing to three seconds.
The host owns exporter dependencies, credentials, spans, content policy and
buffers. See the [Braintrust wiring example](docs/site/content/docs/modules/telemetry.mdx).
