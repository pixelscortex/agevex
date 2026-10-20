# `src/component` — managed assignment, turn queue and bounded child runs

Agevex owns **only** assignment state, the accepted-message backlog, dispatch,
and the coordination record of a bounded asynchronous child run. Threads,
messages, generation and streaming stay owned by the host's native Agent
component; Agevex holds references into it, not copies.

## Files

| File               | Role                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `schema.ts`        | Persisted tables and the return validators the host client imports.                          |
| `queue.ts`         | Host-facing functions: accept, claim, finish, ambiguity, activity.                           |
| `subagents.ts`     | Bounded delegation: reserve, attach, settle, deliver, notify, escalate, history query.       |
| `limits.ts`        | Bounds shared by the component and the host runtime (tokens, abort, watchdog, caps, paging). |
| `worker.ts`        | Workpool action that calls the host's `runTurn` function handle.                             |
| `convex.config.ts` | Mounts **Workpool only**. Not the Agent component, not a Workflow.                           |

## Tables

The component owns four persisted tables. Each has a distinct lifecycle and none
has a retention, expiry or repair API today.

- `assignments` — one row per managed thread. Owns the trusted `subject`/`agent`
  pair, the single in-flight turn's token and its anchored native
  `promptMessageId`, the backlog counters, the host `runTurn` handle, and — on a
  **root** row only — the child-run counters and the delegating turn token with
  the per-prompt launch count already spent for it. Indexed by `threadId`; the
  index is
  an access path, not a uniqueness constraint — "one row per thread" is upheld
  by `accept`. A child thread gets its own row that carries `runId` and
  `rootAssignmentId` instead of counters.
- `pending` — FIFO backlog of accepted but not yet dispatched messages. Stores
  native message ids only. Selecting the head consumes the row in the same
  transaction that anchors the native message id on the turn, so one backlog
  entry is not anchored to a second turn and a duplicate token claim is rejected.
  This is backlog bookkeeping — it is not an exactly-once promise about
  provider, model or tool side effects. A delivered child result enters this same
  backlog, which is how a still-running root is woken without a second
  transcript.
- `receipts` — append-only idempotency ledger for `open`/`send`, keyed by
  `subject + requestKey` with a body fingerprint. A matching fingerprint replays
  the original receipt; a different one is a conflict.
- `subagentRuns` — one row per accepted child delegation. Holds references
  (root/actor assignment, child thread, native message ids), the scoped dedup
  fingerprint, the one-shot delivery capability, the status/delivery status and
  the bounded transition projection. It stores **no task or result body** and no
  transcript copy. Indexes: `by_dedup` for duplicate tool calls, `by_run` for
  point reads, `by_root_sequence` for newest-first history pages. This table
  grows without bound for the lifetime of a backend; there is no cleanup or
  retention API.

- `pending` rows are deleted when `wake` selects them.
- `assignments` rows are updated in place as coordination advances (accept,
  claim, finish, ambiguity, watchdog escalation, run counters, the spent
  per-prompt launch count); they are never deleted.
- `receipts` rows are immutable acceptance records, written once, never updated,
  completed or deleted.
- `subagentRuns` rows are written once at `reserve` and then patched by at most
  three bounded transitions (`started`, terminal, delivery). They are never
  deleted.

`recovery_required` is sticky: it blocks new messages and requires out-of-band
host action.

## Turn model

Assignment state and turn state are separate, and a **child run** is a third,
also separate state. Every assignment — root and child — stays `open` forever;
only a turn reaches a terminal state, and only a _run_ reaches a terminal
`completed`/`failed` status. A failed or completed child never changes its root
assignment's status.

`idle` → `queued` (a turn holds a one-shot token) → `running` (claimed) →
`idle` on success, or `recovery_required` on failure/ambiguity.

- **One turn at a time.** Additional accepted messages wait in `pending` and are
  woken by `finish`, where selection, publishing the turn and enqueuing it happen
  in a single transaction. That transaction is atomic; it is not an
  unconditional liveness guarantee about downstream Workpool scheduling.
- **No takeover.** Duplicate dispatch, stale tokens, late finalization and an
  expired watchdog are all no-ops or escalations. Nothing replays a generation.
- **Watchdog armed on claim**, not on wake, so queue time never consumes the
  120-second execution window (`EXECUTION_WATCHDOG_MS`). The managed generation
  itself aborts cooperatively at 90 seconds (`GENERATION_ABORT_MS`) and is capped
  at 4096 output tokens (`MAX_OUTPUT_TOKENS`).
- **Receipts mean "accepted"**, not success, not a read, not completion.
- **Failures escalate, they do not retry.** A failure that propagates out of the
  host runner reaches the dispatcher, which marks the turn ambiguous promptly; the
  claim-started watchdog is the fallback for an abandoned `running` turn.

## Bounded child runs

A root turn can offer the reserved `agevex_delegate` tool; a child turn and a
result-triggered continuation cannot. Depth is one and a launch is recorded
before any native child thread exists:

`queued` → `running` (claimed) → `completed` | `failed`, with an independent
delivery status `pending` → `accepted` | `failed` | `blocked`.

- **Launch is atomic.** `reserve`, the native child thread/task creation and
  `attach` share one transaction, so a failure anywhere leaves no orphan thread,
  run row or counter.
- **Three children per accepted user prompt, at most five concurrent per root.**
  `reserve` records the delegating turn's
  token and the count already spent for it on the root assignment, so a fourth,
  differently identified launch from the same accepted user prompt is refused
  once its allowance is spent: `TASK_LIMIT` while the root is below its
  concurrent cap. The root's
  `activeRuns` counter is separately capped at five and that cap is checked
  first, so `ACTIVE_LIMIT` is what a launch from another prompt meets once the
  root already holds five. The next accepted user
  prompt has its own allowance of three; a result-triggered continuation has
  none and cannot delegate at all. A row written before the count existed reads
  a missing count for the matching token as one already spent, leaving two. The
  pair is written in that same launch
  transaction, so a failed launch does not spend it, and it is never restored by
  a child that fails, completes or fails to deliver.
- **Settlement is authenticated.** A run is recorded `completed` only after the
  reported native message id is verified against the child transcript, its stored
  root/subject and the expected agent. An empty or unverifiable result settles
  `failed` with a sanitized code.
- **Delivery is a queue hand-off, not a read.** `accepted` means the native parent
  message and the component backlog committed together; it does not mean the root
  read, understood or acknowledged anything, and concurrent attempts are not
  exactly-once. A failed attempt is recorded `failed` by a separate metadata-only
  transition; if even that cannot commit the run stays honestly `pending`. The
  child runner attempts that delivery after the outcome is committed and before it
  finalizes its own turn, so a finalization failure cannot skip notification.
- **The watchdog makes one bounded notification attempt** through the stored
  coordinator handle and one-shot capability. It never replays a generation, never
  takes an owner over and never invents progress.
