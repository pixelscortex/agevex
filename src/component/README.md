# Component ownership

Mount `agevex/convex.config` beside the host's native Agent component.
Agevex internally mounts two Workflow components, each with its own nested
Workpool: root parallelism 2, child parallelism 4. Hosts export `runTurn` and
`coordinate`; no host Workflow exports are required.

Transcripts, tasks and result bodies stay in Agent. Workflow owns journals,
events, nested-workflow cancellation and work dispatch. Agevex tables hold
only ids, counters and fences.

## Life of a turn

1. **send**: the host saves the prompt natively and calls `queue.accept` in the
   same transaction (`queue/accept.ts`): run budget, ready `inbox` row, request
   receipt.
2. **inbox → wake**: `wake` (`queue/wake.ts`) reserves the oldest ready row as
   the queued turn (`turnToken`) and starts or pings the loop workflow.
3. **loop**: the loop (`workflows.ts`) gets the token from `queue.next`, then
   runs a turn workflow: one `worker.dispatch` action per paid slice.
4. **claim**: the host action calls `queue.claim` (`queue/claim.ts`). It
   consumes the head and merges consecutive results, saves pending notes,
   marks the turn running and arms the slice watchdog.
5. **generate**: every native write goes through `queue.write`
   (`queue/write.ts`): the token/epoch fence, message refs, pending generation,
   child result id and approval pauses (`queue/pause.ts`).
6. **between slices**: `continueTurn` + `betweenSlices` (`queue/slice.ts`).
7. **finish/settle**: `finish` (`queue/finish.ts`) idles the turn or parks it
   in `recovery_required`. A child reports through `subagents.settle`; its
   run settles once nothing fences it (`subagents/settlement.ts`, R3).
8. **deliver**: `subagents.notify` asks the host coordinator to save the
   result in the parent thread. `subagents.deliver` (`subagents/delivery.ts`)
   then enqueues it as parent work, or marks its wait-"all" cohort ready
   (`subagents/groups.ts`), and wakes the parent.

Failures never re-run paid work. The paths are the watchdog (`stalled`), a
throwing action (`ambiguous`), a failed loop (`failWorkflow`) and the slice
cap (`sliceLimit`). `cancel` (`queue/cancel.ts`) fences the root and every
live descendant in one transaction. `reconcile` re-rings a loop whose ping
was lost.

## File map

Entry files hold only registered Convex functions; their path is the API
path. The folder with the same name holds that entry's helpers.

| File                       | Contents                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `convex.config.ts`         | Component definition; mounts the root/child Workflow lanes.                         |
| `schema.ts`                | All tables and the shared public validators (also used by the client).              |
| `limits.ts`                | `PLATFORM`, `HOST_LIMITS`, `LIMITS`, the cancel budget arithmetic, `resolveLimits`. |
| `facts.ts`                 | Validation of identity facts (subject, thread id).                                  |
| `models.ts`                | Model-override validator and bounds.                                                |
| `approvals.ts`             | SHA-256 keys for native ids; native approval-response/denial save.                  |
| `queue.ts`                 | Entry: turn lifecycle (accept, claim, write, finish, respond/answer, cancel, ...).  |
| `queue/accept.ts`          | Send admission and request receipts.                                                |
| `queue/assignments.ts`     | `assignments` lookup by thread; root/child row builders.                            |
| `queue/inbox.ts`           | The shared ready-range reads of `inbox`.                                            |
| `queue/runs.ts`            | `runs` row builder.                                                                 |
| `queue/wake.ts`            | `wake` (reserve head, start/ping loop), `queue.next`, `queue.reconcile`.            |
| `queue/recovery.ts`        | The scheduled recovery check; `cancelIfPending`.                                    |
| `queue/claim.ts`           | Slice claim: head consumption, note flush, watchdog, run start.                     |
| `queue/write.ts`           | The native-write fence and the facts recorded with each save.                       |
| `queue/pause.ts`           | Approval/deferred-call pauses: count, collect, retire, suspend.                     |
| `queue/responses.ts`       | `respond`/`answer` with response receipts.                                          |
| `queue/slice.ts`           | Slice boundaries: `disarmSlice`, `continueTurn`, `betweenSlices`.                   |
| `queue/finish.ts`          | Turn end and failure paths (defer, escalate, ambiguous, stall).                     |
| `queue/cancel.ts`          | Root cancellation in one bounded transaction.                                       |
| `queue/views.ts`           | `activity`, `execution` and `assignment` projections.                               |
| `subagents.ts`             | Entry: delegation (reserve, attach, settle, deliver, messages, views).              |
| `subagents/runs.ts`        | `subagentRuns` lookups, event ring, cohort read, row builder.                       |
| `subagents/launch.ts`      | Delegation admission (`reserve`) and child attachment (`attach`).                   |
| `subagents/settlement.ts`  | Settlement fence, R3, `settle`/`escalate`, notify scheduling.                       |
| `subagents/groups.ts`      | Wait-"all" cohorts: seal, ready, release.                                           |
| `subagents/delivery.ts`    | Applying a delivery outcome to the parent.                                          |
| `subagents/interaction.ts` | Parent→child messages and child→parent questions.                                   |
| `subagents/views.ts`       | Trusted contexts, delegation history page, request tree.                            |
| `hooks.ts`                 | Entry: notes, hook state, routing, side reviews, origins.                           |
| `hooks/notes.ts`           | Note admission, claim-time saving, before-turn notes, cancel cleanup.               |
| `hooks/refs.ts`            | Exact-message ref ring; side-review window and boundary.                            |
| `hooks/state.ts`           | Hook model choice, completed turns, afterTurn continuations.                        |
| `hooks/routing.ts`         | beforeTurn model-routing ownership.                                                 |
| `hooks/origins.ts`         | Page-local message origins.                                                         |
| `ledger.ts`                | Entry: effect ledger (`begin`/`complete`/`unknown`) and `purge`.                    |
| `receipts/records.ts`      | Receipt lookup, done-receipt builder, purge arming.                                 |
| `receipts/claims.ts`       | Claim/lease protocol and the optional turn fence.                                   |
| `files.ts`                 | Entry: attachment grants and message bindings.                                      |
| `files/grants.ts`          | Attestation lookups, identity checks, binding writes.                               |
| `cancellation.ts`          | Entry: post-cancel cleanup jobs and `close`.                                        |
| `cancellation/cleanup.ts`  | Stream abort, placeholder failure, one-request denial step.                         |
| `workflows.ts`             | Entry: versioned loop/turn step sequences and loop rotation.                        |
| `workflows/lanes.ts`       | Root/child lane managers and `startLoop`.                                           |
| `worker.ts`                | Entry: `dispatch`, one non-retried paid slice.                                      |

## Tables

| Table          | Written by                                                                                                                                                                                                                                                                                                    | Notes                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `assignments`  | `queue/*` (most fields), `subagents/launch.ts` (child rows), `hooks/*` (refs, reviews, notes counters, continuation), `cancellation*` (pause/cleanup)                                                                                                                                                         | One managed thread.                             |
| `inbox`        | `queue/accept.ts`, `queue/pause.ts`, `queue/responses.ts` (continuation `messageId`), `subagents/delivery.ts`, `subagents/groups.ts`, `subagents/interaction.ts`, `subagents/launch.ts`, `hooks/notes.ts`, `hooks/state.ts`; consumed by `queue/claim.ts`; deleted by `queue/finish.ts` and `queue/cancel.ts` | Ready work, notes, control ids.                 |
| `runs`         | `queue/accept.ts` (create), `queue/claim.ts`, `hooks/*`, `subagents/*` (spend), `queue/cancel.ts`                                                                                                                                                                                                             | One request's shared budget.                    |
| `receipts`     | `receipts/*` via `ledger.ts`, `queue/accept.ts`, `queue/responses.ts`, `files/grants.ts`                                                                                                                                                                                                                      | Idempotency ledger and attachment attestations. |
| `subagentRuns` | `subagents/*`, `queue/claim.ts` (started), `queue/write.ts` (result id), `queue/cancel.ts`                                                                                                                                                                                                                    | One delegation.                                 |

What each table and field holds:

- `assignments`: ownership, native thread references, workflow id, current run,
  one execution token and cancellation epoch, the next-run model policy, and
  bounded native approval/deferred-call references, exact message references,
  side-review boundaries and note/turn counters.
  `logicalPromptMessageId` identifies the prompt read by `beforeTurn`, including
  a continuation. `promptMessageId` bounds native generation context.
  Posted notes wait for the next turn claim with no decided approvals awaiting
  committed results; ordinary tool slices never drain them. `beforeTurn` hook
  notes are saved before the first generation.
- `inbox`: FIFO ready message references, passive notes and retained control ids.
  `text` holds a posted note or a staged hook prompt until claim; `noteEpoch`
  isolates cancelled payloads from fresh admission/cleanup. Claim saves notes
  before a staged prompt. `join` carries a joined group's newest and earliest
  member anchors. `from` labels notes in context and
  the public reader. After save, `messageId`/`kind`/`from` retain origin metadata
  with `passive: false`; `by_message` reads only ids on the requested page.
  The ready index selects `passive: undefined`, so controls never start work or
  block settlement. Cancel fences notes immediately, then a finite job per
  assignment removes unsaved bodies without loading them in the cancel budget.
  A reserved row stays until claim, so approvals retain their work.
- `runs`: one accepted user request and all caused work; launch/hop counters,
  cancellation, outstanding result deliveries, and a per-agent model choice
  fixed at run start and read by every turn claim, 64-bit start/routing masks, and
  separate hook-continuation/side-run counters.
- `receipts`: one shared `(scope, key)` ledger for request acceptance and tools;
  input fingerprint, claim fence, lease, status, bounded result and TTL. Request
  results retain the original inbox position for typed duplicate receipts.
- `subagentRuns`: child linkage, verified native result reference, root epoch,
  delivery capability, bounded transition history and the side-run marker.
  `by_result_message` supplies page-local result origins without reading history.
  That marker excludes side runs from the settlement fence and routes their
  replies to passive notes without spending model delegation hops.

`workflows.ts` fixes the versioned loop/turn step sequence. Each action is one
paid model slice with retries disabled. `betweenSlices` keeps its version-1
sequence; notes and hooks are consumed inside `agentStep` without new journal
entries. Loops rotate after a bounded number of turns/doorbells to keep the
8 MiB journal bounded; old completed loops are cleaned up.

`ledger.purge` runs a single scheduled chain while the ledger is nonempty,
removing at most `LIMITS.purgeBatch` indexed expired rows per mutation. No table
mirrors Workflow/Workpool internals. `agevex/test` mounts extra inspection
functions only inside the test harness to verify and replay real journals.
