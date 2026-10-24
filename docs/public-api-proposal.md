# Agevex core API

> The contract below is **implemented** in `src/client` and exercised through
> the public package by this repository's own component tests. The historical
> filename is
> retained. A **bounded asynchronous Main → Researcher → Main delegation path**
> is implemented as well; explicit assignment completion, general coordination
> engines, peer-to-peer messaging, review engines and nesting beyond depth 1
> remain proposals, not exports. Everything stated here is pinned by the tests
> in `tests/`; anything not stated as implemented is not exported.

## Direction

Define ordinary native Convex Agents, optionally annotate them with a
delegation graph, and register one managed runtime that owns assignment
acknowledgement, scheduling and authorization. The client starts work and
immediately receives an acceptance receipt; the transcript stays native, read
through native Agent queries and hooks.

This supersedes the earlier Workflow-default sketch: **the composed runtime is
WORKPOOL-backed and Workflow is not required.** The native Agent component keeps
owning threads, messages, generation and streaming; Agevex never forks or
duplicates a transcript. Delegation augments that native runtime with bounded
asynchronous child execution; it does not become a second conversation layer.

## Native versus implemented

| Surface                                                               | Status                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Native Agent models, tools, transcripts, generation, streaming        | Existing upstream behavior; preserve it                               |
| Native `generateText` / `streamText` return types                     | Unchanged upstream types                                              |
| Native `useUIMessages`                                                | Existing upstream hook; preserve its query contract                   |
| `Agent` extension with `subagents: []`                                | Implemented additive subclass                                         |
| `registerAgent` over a WORKPOOL-backed component                      | Implemented; one registration, one host action                        |
| Managed `open` / `send` receipts                                      | Implemented Agevex behavior                                           |
| `messages` query                                                      | Implemented authorized wrapper preserving native pagination + streams |
| `activity` query                                                      | Implemented additive query, not a replacement message protocol        |
| `delegations` query                                                   | Implemented authorized history query with bounded newest-first paging |
| Reserved `agevex_delegate` tool and the `coordinate` reference        | Implemented; depth 1, at most five active children per root           |
| Bounded Main → Researcher → Main result delivery                      | Implemented asynchronous path                                         |
| General coordination tools, completion policy, peers, review, nesting | Explicitly deferred to a later slice                                  |

## 1. Mount components

```ts
// Consumer setup: convex/convex.config.ts
import { defineApp } from "convex/server";
import agent from "@convex-dev/agent/convex.config";
import agevex from "agevex/convex.config";

const app = defineApp();
app.use(agent);
app.use(agevex);
export default app;
```

The host mounts the native Agent component and Agevex as siblings. Agevex
mounts **Workpool only**; no host Workflow export is required, and none is
provided by this slice.

Agents are constructed with `components.agent`, never `components.agevex`.

## 2. Define agents in the native shape

```ts
// convex/agentDefinitions.ts
import { Agent } from "agevex";
// Models and domain tools are ordinary host-owned definitions, omitted here.
export const main = new Agent(components.agent, {
  name: "Main",
  languageModel: chatModel,
  subagents: [],
});
```

- `Agent` extends the native Agent, so custom execution context, tools,
  generics, method signatures and inherited behavior must keep working. This
  is checked by `tests/native-fidelity.test-d.ts`; inherited results are unchanged.
- `subagents` declares the delegation graph. It is no longer metadata only: a
  registered root may be offered the reserved `agevex_delegate` tool for its
  declared children. Depth is limited to 1, and registration rejects unknown or
  name-only entries, duplicate child names bound to different objects, cycles, a
  root declared as somebody's child, and any host tool that collides with the
  reserved tool name.
- `agents` in the registration lists the allowed **roots**. A child is resolved
  through its root's `subagents` and does not have to be a root itself.

## 3. Register once

```ts
// convex/agents.ts (explicit action typing breaks generated-reference cycles)
import { registerAgent, type TurnArgs } from "agevex";
import type { FunctionReference, RegisteredAction } from "convex/server";
import { components, internal } from "./_generated/api.js";

const runtime = registerAgent(components.agevex, {
  agents: [main],
  refs: {
    runTurn: (): FunctionReference<"action", "internal", TurnArgs, null> => internal.agents.runTurn,
    // Required only when a root declares subagents.
    coordinate: (): FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult> =>
      internal.agents.coordinate,
  },
  authorize: hostPolicy,
  authorizeExecution: hostExecutionPolicy,
});
export const runTurn: RegisteredAction<"internal", TurnArgs, null> =
  runtime.internalFunctions().runTurn;
export const coordinate: RegisteredMutation<"internal", CoordinateArgs, CoordinateResult> =
  runtime.internalFunctions().coordinate;
export const { open, send, messages, activity, delegations } = runtime.authorizedEndpoints();
```

- Two host internal functions are involved:
  `internal.agents.runTurn({ assignmentId: string, turnToken: string }): null` for
  every managed root and child turn, and
  `internal.agents.coordinate(args: CoordinateArgs): CoordinateResult` for the
  three delegation operations. `subagents: []` with only `runTurn` remains a
  supported Main-only registration. Factories must produce real registered Convex
  functions; generated-reference inference cycles are resolved with explicit
  `RegisteredAction` / `RegisteredMutation` / `FunctionReference` annotations,
  never by casting through `anyApi`.
- There is **no** `runChildTurn` entry point and **no** third authorization
  callback. A child turn is an ordinary managed turn dispatched through
  `runTurn`.
- `CoordinateArgs` is exactly three operations: `launch`
  (`{ assignmentId, turnToken, toolCallId, agent, task }`), `settle`
  (`{ assignmentId, turnToken, runId, resultMessageId?, errorCode }`) and
  `notify` (`{ runId, deliveryToken }`). Each is authenticated by a capability
  the caller already holds — the actor's currently running turn token, the child
  turn token that owns the run, and the one-shot delivery capability minted at
  launch. `launch` returns a receipt or a sanitized denial; `settle` and `notify`
  return `null`, because their outcome is persisted state, not a return value.
- Managed registration supports agents that need no added custom execution
  context in this prototype. A requirement for custom context must be rejected
  or documented, not cast away.
- The host supplies models, tools, authorization and policy. Agevex owns
  assignment state, queueing and dispatch.

## 4. Mandatory host authorization

```ts
// Public operations. `delegations` is an authorized read like `messages`.
authorize(ctx, {
  operation: "open" | "send" | "messages" | "activity" | "delegations",
  agent: string,
  threadId?: string,
}): Promise<{ subject: string }>;

// Background operations, added because a launch and a result delivery both act
// with no end user on the connection. `agent`/`threadId` still identify the ROOT.
authorize(ctx, {
  operation: "delegate",
  agent: string;
  threadId: string;
  subject: string;
  rootAssignmentId: string;
  rootAgent: string;
  actorAgent: string;
  childAgent: string;
  task: string;
}): Promise<{ subject: string }>;

authorize(ctx, {
  operation: "deliver", /* …as `delegate`, plus `runId: string` */
}): Promise<{ subject: string }>;

authorizeExecution(actionCtx, {
  subject: string,
  agent: string,
  assignmentId: string,
  threadId: string;
  turnOrigin: "user" | "subagent_result";
  child?: {
    rootAssignmentId: string;
    rootThreadId: string;
    rootAgent: string;
    runId: string;
    actorAgent: string;
    childAgent: string;
  };
}): Promise<void>;
```

- No default allow. Operations on an existing thread compare the trusted
  returned subject with persisted assignment ownership. Hosts must resolve the
  subject from trusted authorization, not client input.
- Execution authorization rechecks the trusted persisted scope before
  generation: a scheduled execution must not assume the original caller's
  identity survives. It runs before **every** managed generation, including a
  child turn and a result-triggered continuation, and `child` is present exactly
  when the turn belongs to a delegated run.
- Background scopes are only constructed **after** the capability and linkage
  were validated from persisted state, and every field in them is server-derived.
  `ctx.auth` may be `null` there, so the host policy must branch explicitly and
  recheck the capability-validated stored principal against current policy;
  echoing the supplied `subject` back is not authorization. The returned subject
  must be nonempty and equal the persisted root owner, or the operation fails
  closed.
- Execution and delivery tokens, and any child thread id, are never exposed to a
  client. Public reads (`messages`, `activity`, `delegations`) stay subject-owned.
- Domain tools remain responsible for their own access checks.
- The host owns its authorization policy entirely; this package ships none. A
  policy that shares one subject across every caller is a shared local scope,
  not user authentication, and a policy that cannot resolve the trusted
  principal must fail closed rather than default to an allow.

## 5. Start work and receive a receipt

```ts
// Implemented endpoint calls (via host-generated api.agents references).
const opened = await open({
  agent: "Main",
  prompt: "Prepare an evidence-backed launch brief.",
  requestKey: crypto.randomUUID(),
});
await send({
  threadId: opened.threadId,
  text: "Focus on small teams.",
  requestKey: crypto.randomUUID(),
});
```

```ts
type Receipt = {
  assignmentId: string;
  threadId: string;
  receiptId: string;
  status: "accepted";
};
```

- `open` and `send` return an acceptance receipt, never generated text and
  never a completed task.
- The wrappers do not hold the client request open until the model finishes.
- The dedup key is the trusted `subject + requestKey`. An identical
  operation/target/body returns the original receipt; changed input is a
  conflict, detected before any native thread or message write.
- Accepted work queues while its recipient is busy. Messages that arrive during
  a running turn never silently enter that turn's context; idle recipients get
  the next turn.

## 6. Keep the native React experience

```ts
// Implemented authorized query + existing native hook.
api.agents.messages; // query { threadId, paginationOpts, streamArgs? }
// -> native PaginationResult<UIMessage> & { streams: native syncStreams result }
api.agents.activity; // query { threadId } -> Activity
api.agents.delegations; // query { threadId, paginationOpts } -> PaginationResult<SubagentRun>
```

```tsx
import { useUIMessages } from "@convex-dev/agent/react";
import { useQuery } from "convex/react";

function Conversation({ threadId }: { threadId: string }) {
  const { results, status, loadMore } = useUIMessages(
    api.agents.messages,
    { threadId },
    { initialNumItems: 20, stream: true },
  );
  const activity = useQuery(api.agents.activity, { threadId });
  // Render results with an ordinary native-message renderer.
  // Use status/loadMore for pagination; activity for coordination status.
}
```

- `messages` uses native `listUIMessages` **and** `syncStreams`; native
  pagination fields and native UI-message/parts types are retained. The
  upstream raw `MessageDoc` page validator is not substituted.
- There is no Agevex-specific streaming hook, and no Agevex-specific
  presentation of the transcript.
- No child transcript API exists. A child's output reaches the parent only as the
  native result message written by delivery; there is no endpoint that exposes a
  child thread, a turn token or a delivery capability.

```ts
type Activity = {
  assignmentId: string;
  threadId: string;
  agent: string;
  assignmentStatus: "open";
  turnStatus: "queued" | "running" | "idle" | "recovery_required";
  queuedMessages: number;
  errorCode: null | "GENERATION_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS";
  // Additive: all-zero for a Main-only registration.
  subagents: { active: number; history: number; total: number };
};
```

Errors surfaced through activity are sanitized codes, not raw provider or tool
exceptions. An idle turn is not task completion.

```ts
type SubagentRun = {
  runId: string;
  agent: string;
  status: "queued" | "running" | "completed" | "failed";
  deliveryStatus: "pending" | "accepted" | "failed" | "blocked";
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  deliveryAt: number | null;
  resultMessageId: string | null;
  errorCode:
    | null
    | "GENERATION_FAILED"
    | "EXECUTION_AMBIGUOUS"
    | "EMPTY_RESULT"
    | "RESULT_UNVERIFIED"
    | "AUTHORIZATION_DENIED"
    | "ROOT_UNAVAILABLE"
    | "DELIVERY_FAILED";
  events: { runId: string; agent: string; phase: string; at: number; errorCode: string | null }[];
};
```

- `active = queued + running`, `history = completed + failed`,
  `total = active + history`. Counters move atomically once per accepted launch
  and once per terminal transition.
- `delegations` pages newest first, defaults to 20 items and clamps at 50. It is
  subject-owned and carries **no** child thread id, token or result text; the
  result itself is the native parent message reachable through `resultMessageId`.
- `events` is a fixed-size projection of persisted transitions
  (`queued`, `started`, `completed`/`failed`, `result_accepted`,
  `delivery_failed`, `delivery_blocked`). It is not a progress, reasoning or
  queue-position feed: nothing is reported before it is persisted, and
  `deliveryStatus: "accepted"` never implies the root read, understood or
  acknowledged the result.

## 7. Managed turn semantics

- Acceptance atomically saves each input once to the native thread and persists
  receipt/ownership/queue metadata. There is no second transcript.
- Component scheduling stores native message IDs, not copied bodies. Each turn
  uses one fixed native `promptMessageId`, so later arrivals cannot slip into
  its context.
- One persisted owner and token per assignment: busy arrivals queue, idle
  arrivals schedule, and a transactional finish/wake step prevents lost
  wakeups. Duplicate dispatch or finalization is harmless.
- Workpool queues a typed component `worker.dispatch`; the dispatcher invokes
  the host `runTurn` handle through `ctx.runAction`. Workpool's public
  `enqueueAction` is not assumed to accept handles, and its private enqueue
  implementation is not coupled to.
- Host generation under management is bounded: one native streamed step, 4096
  output tokens, a 90 second cooperative abort, the stream is consumed, and
  terminal success is verified from the native saves that completed.
- Those bounds apply **only** to managed execution. Inherited direct native
  methods stay native and unmanaged; running direct generation concurrently on
  a managed thread is unsupported.
- Workpool action retries and AI SDK retries are disabled (`maxRetries: 0`).
  Failure or ambiguous execution becomes visible recovery state: no automatic
  replay, no expired-owner takeover, and no action that waits on a peer. A
  detection-only watchdog **armed on claim** marks an abandoned `running` token
  ambiguous after 120 seconds; queue wait never consumes that window, and the
  watchdog never replaces its owner. Recovery blocks new messages, with no repair
  API.
- The 90-second abort is cooperative with the model/provider, not a guarantee
  that an uncooperative provider stops work. No replacement generation starts
  even if an owner becomes stuck.
- Every assignment — root and child — remains **open** forever. A turn ending is
  not a finished task, and a terminal child **run** never changes its root
  assignment's status; explicit assignment completion is not implemented.

## 7a. Bounded asynchronous delegation

The supported flow is `Main → Researcher → Main` at depth 1.

- A root turn of **user** origin is offered the reserved `agevex_delegate` tool
  with input `{ agent, task }` (task nonblank, ≤ 4000 characters). Child turns and
  result-triggered continuations are never offered it, and a continuation cannot
  reset the original allowance.
- The managed tool action awaits only the short launch transaction. It never waits
  for the child, never consumes the parent's execution slot, and never takes over
  the native transcript.
- A launch is atomic: capability and policy check, scoped dedup on
  `actor assignment + turn token + native tool call id`, root counters, native
  child thread/task creation and the queue hand-off all commit together. The same
  tuple replays its original run id; the same tuple with a changed payload is
  `DELEGATION_CONFLICT`. `TASK_LIMIT` also covers the per-prompt allowance: one
  accepted user prompt may launch at most three children, and the spent allowance
  is persisted on the root assignment as the delegating turn's token plus a
  count, rather than derived from the active counter, so a fast-completed child
  cannot reopen it inside one prompt. Expected
  refusals — `ACTIVE_LIMIT`, `TASK_LIMIT`, `FORBIDDEN`, `STALE_TURN`,
  `DELEGATION_CONFLICT` — are **tool results**, not root-generation failures.
- A child runs the same bounded managed turn as any root turn, with its own claim
  token, its own execution authorization and its own claim-armed watchdog. It is
  recorded `completed` only when a verified, nonempty native final result exists;
  an empty, tool-only, aborted or unverifiable result settles `failed` with a
  sanitized code.
- Settlement records the terminal outcome. Delivery then saves the compact result
  as a native parent message **and** accepts it into the parent backlog in one
  transaction, waking an idle root or queueing behind a running one. A root that
  is still running never loses the wakeup.
- Delivery semantics are deliberately narrow: `accepted` means the native parent
  message and the backlog both committed. It is not a read receipt, not
  acknowledgement, and not an exactly-once guarantee about provider, model or
  tool effects. A denied or unavailable root records `blocked` with no parent
  write; a transaction failure records `failed` through a separate metadata-only
  transition; if that cannot commit either, the run stays honestly `pending`.
- Bounds, as implemented: depth 1, at most five concurrent active child runs
  per root, at most
  three children per accepted user prompt, one model step per turn, and at most
  three model turns per task (initial Main, Researcher, Main continuation). One
  prompt that explicitly requests three tasks therefore costs one Main call plus
  three Researcher calls plus up to three result continuations; that is what the
  a host can ask for, not a guaranteed spend.
  The concurrent cap is a bounded per-root ceiling across prompts, raised from
  one to five; it is not unlimited fanout, and it does not relax the per-prompt
  bound.
  The per-prompt bound is persisted on the root assignment (the delegating turn's
  token plus the launches already spent for it), not derived from the active
  counter: a child that completes while its
  parent turn is still running no longer reopens the allowance, a
  `subagent_result` continuation gets no allowance at all, and the next accepted
  user prompt gets its own three. A launch that rolls back does not spend it.
  Shared Workpool parallelism stays 4 across roots and children.

## 8. Explicitly not in this slice

- Explicit assignment completion and any host completion check; every assignment
  stays `open` and a finished turn is not a finished task.
- A general coordination engine (`list`, `reply`, `yield`, `complete`), peer-to-peer
  agent messaging, a review engine, or agents delegating to their own children.
- Depth greater than one, more than five concurrent children per root, more
  than three children per accepted user prompt, and any unlimited fanout.
- Workflow-based continuation, recovery or repair APIs, and any transcript or
  hook that replaces native `useUIMessages`.
- Explicit completion of the parent task by a delivered child result: delivery is
  queue hand-off only.
- Package publication, tenant isolation and production authorization.

Inherited native generation remains unmanaged; subclassing alone does not
coordinate arbitrary native calls or make them recoverable. The bounded
delegation path above augments the native Agent with Workpool-backed execution;
it does not become a second transcript or a Workflow requirement.

## Evidence

- [Native Agent source, pinned inspection](https://github.com/get-convex/agent/blob/d143f27c0dc1ce7269db38cf8d450e85a39e186f/src/vercel/index.ts)
- [Native UI hook, pinned inspection](https://github.com/get-convex/agent/blob/d143f27c0dc1ce7269db38cf8d450e85a39e186f/src/vercel/react/useUIMessages.ts)
- [Workflow documentation](https://github.com/get-convex/workflow/tree/ddc28f3d14337044dfe8bbc9b4b497463daf7100)
- [Workpool documentation](https://docs.convex.dev/components/workpool)
- [Convex agent mode](https://docs.convex.dev/cli/agent-mode)
