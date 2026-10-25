# Component ownership

Mount `agevex/convex.config` beside the host's native Agent component.
Agevex internally mounts two Workflow components, each with its own nested
Workpool: root parallelism 2, child parallelism 4. Hosts export `runTurn` and
`coordinate`; no host Workflow exports are required.

Transcripts, tasks and result bodies stay in Agent. Workflow owns journals,
events, nested-workflow cancellation and work dispatch. Agevex tables hold
only ids, counters and fences.

## Life of a turn

1. **send**: the host saves the prompt natively and calls `turns.send.accept` in the
   same transaction (`turns/send.ts`): run budget, ready `inbox` row, request
   receipt.
2. **inbox → wake**: `wake` (`turns/wake.ts`) reserves the oldest ready row as
   the queued turn (`turnToken`) and starts or pings the loop workflow.
3. **loop**: the loop (`workflows/lanes.ts`) gets the token from `turns.loop.next`, then
   runs a turn workflow: one `workflows.worker.dispatch` action per paid slice.
4. **claim**: the host action calls `turns.slices.claim` (`turns/claim.ts`). It
   consumes the head and merges consecutive results, saves pending notes,
   marks the turn running and arms the slice watchdog.
5. **generate**: every native write goes through `turns.slices.write`
   (`turns/write.ts`): the token/epoch fence, message refs, pending generation,
   child result id and approval pauses (`turns/pause.ts`).
6. **between slices**: `turns.slices.continueTurn`, then the turn workflow's
   `turns.slices.betweenSlices` step (`turns/boundaries.ts`).
7. **finish/settle**: `finish` (`turns/finish.ts`) idles the turn or parks it
   in `recovery_required`. A child reports through `subagents.settle.settle`; its
   run settles once nothing fences it (`subagents/settle.ts`, R3).
8. **deliver**: `subagents.deliver.notify` asks the host coordinator to save the
   result in the parent thread. `subagents.deliver.deliver` (`subagents/deliver.ts`)
   then enqueues it as parent work, or marks its wait-"all" cohort ready
   (`subagents/groups.ts`), and wakes the parent.

Failures never re-run paid work. The paths are the watchdog (`stalled`), a
throwing action (`ambiguous`), a failed loop (`failWorkflow`) and the slice
cap (`sliceLimit`). `cancel` (`turns/cancel.ts`) fences the root and every
live descendant in one transaction. `reconcile` re-rings a loop whose ping
was lost.

## File map

Registered Convex functions live in the concept folders; a file's path is its
API path (`turns/send.ts` -> `components.agevex.turns.send.accept`). A
registered file holds the helpers only it uses; helpers shared by several
registered files are separate modules in the same folder. Top-level files are
the definition, the schema and helpers used across folders and by the client.

| File                      | Contents                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `convex.config.ts`        | Component definition; mounts the root/child Workflow lanes.                                         |
| `schema.ts`               | All tables and the shared public validators (also used by the client).                              |
| `limits.ts`               | `PLATFORM`, `HOST_LIMITS`, `LIMITS`, the cancel budget arithmetic, `resolveLimits`.                 |
| `facts.ts`                | Validation of identity facts (subject, thread id).                                                  |
| `models.ts`               | Model-override validator and bounds.                                                                |
| `approvals.ts`            | SHA-256 keys for native ids; native approval-response/denial save.                                  |
| `turns/send.ts`           | Registered: `accept`, `lookupReceipt`, `admission`, `assignment`, `activity`.                       |
| `turns/slices.ts`         | Registered: `claim`, `write`, `continueTurn`, `betweenSlices`, `finish`, `sliceLimit`, `execution`. |
| `turns/failures.ts`       | Registered: `ambiguous`, `stalled`, `failWorkflow`.                                                 |
| `turns/approvals.ts`      | Registered: `respond`, `answer`, with response receipts.                                            |
| `turns/cancel.ts`         | Registered: `cancel`, root cancellation in one bounded transaction.                                 |
| `turns/loop.ts`           | Registered: `next`, `reconcile`.                                                                    |
| `turns/assignments.ts`    | `assignments` lookup by thread; root/child row builders.                                            |
| `turns/inbox.ts`          | The shared ready-range reads of `inbox`.                                                            |
| `turns/runs.ts`           | `runs` row builder.                                                                                 |
| `turns/wake.ts`           | `wake` (reserve head, start/ping loop), the loop's next turn, doorbell recovery.                    |
| `turns/recovery.ts`       | The scheduled recovery check; `cancelIfPending`.                                                    |
| `turns/claim.ts`          | Slice claim: head consumption, note flush, watchdog, run start.                                     |
| `turns/write.ts`          | The native-write fence and the facts recorded with each save.                                       |
| `turns/pause.ts`          | Approval/deferred-call pauses: count, collect, retire, suspend.                                     |
| `turns/boundaries.ts`     | Slice boundaries: `disarmSlice`, `closeSlice`, `admitNextSlice`.                                    |
| `turns/finish.ts`         | Turn end and failure paths (defer, escalate, ambiguous, stall).                                     |
| `turns/views.ts`          | `activity`, `execution` and `assignment` projections.                                               |
| `subagents/launch.ts`     | Registered: `delegateContext`, `reserve`, `attach`.                                                 |
| `subagents/settle.ts`     | Registered: `settlementContext`, `settle`, `escalate`; settlement fence, R3, notify.                |
| `subagents/deliver.ts`    | Registered: `notify`, `deliveryContext`, `deliver`, `failDelivery`, `releaseGroups`.                |
| `subagents/messages.ts`   | Registered: `interactionContext`, `messageChild`, `askParent`, `questionContext`.                   |
| `subagents/history.ts`    | Registered: `delegations`, `runTree`.                                                               |
| `subagents/runs.ts`       | `subagentRuns` lookups, event ring, cohort read, row builder.                                       |
| `subagents/groups.ts`     | Wait-"all" cohorts: seal, ready, release.                                                           |
| `subagents/views.ts`      | Trusted contexts, delegation history page, request tree.                                            |
| `hooks/notes.ts`          | Registered: `addNote`, `beforeTurnNote`, `cancelNotes`; claim-time note saving.                     |
| `hooks/state.ts`          | Registered: `hookState`, `continueAdmission`.                                                       |
| `hooks/routing.ts`        | Registered: `routing`, `completeRouting`; beforeTurn model-routing ownership.                       |
| `hooks/reviews.ts`        | Registered: `reviewContext`, `reviewed`, `capture`.                                                 |
| `hooks/origins.ts`        | Registered: `origins`, page-local message origins.                                                  |
| `hooks/refs.ts`           | Exact-message ref ring; side-review window and boundary.                                            |
| `receipts/effects.ts`     | Registered: `begin`, `complete`, `unknown`, `purge`; the claim/lease protocol.                      |
| `receipts/records.ts`     | Receipt lookup, done-receipt builder, purge arming.                                                 |
| `files/attachments.ts`    | Registered: `register`, `owns`, `attach`, `forMessage`; grant and binding rows.                     |
| `cancellation/cleanup.ts` | Registered: `cleanup`, `cleanupBatch`, `close`; stream abort, placeholder failure, denials.         |
| `workflows/lanes.ts`      | Registered: root/child `Turn`/`Loop`/`Done`; lane managers and `startLoop`.                         |
| `workflows/worker.ts`     | Registered: `dispatch`, one non-retried paid slice.                                                 |

## Tables

| Table          | Written by                                                                                                                                                                                                                                                                                              | Notes                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `assignments`  | `turns/*` (most fields), `subagents/launch.ts` (child rows), `hooks/*` (refs, reviews, notes counters, continuation), `cancellation*` (pause/cleanup)                                                                                                                                                   | One managed thread.                             |
| `inbox`        | `turns/send.ts`, `turns/pause.ts`, `turns/approvals.ts` (continuation `messageId`), `subagents/deliver.ts`, `subagents/groups.ts`, `subagents/messages.ts`, `subagents/launch.ts`, `hooks/notes.ts`, `hooks/state.ts`; consumed by `turns/claim.ts`; deleted by `turns/finish.ts` and `turns/cancel.ts` | Ready work, notes, control ids.                 |
| `runs`         | `turns/send.ts` (create), `turns/claim.ts`, `hooks/*`, `subagents/*` (spend), `turns/cancel.ts`                                                                                                                                                                                                         | One request's shared budget.                    |
| `receipts`     | `receipts/*`, `turns/send.ts`, `turns/approvals.ts`, `files/attachments.ts`                                                                                                                                                                                                                             | Idempotency ledger and attachment attestations. |
| `subagentRuns` | `subagents/*`, `turns/claim.ts` (started), `turns/write.ts` (result id), `turns/cancel.ts`                                                                                                                                                                                                              | One delegation.                                 |

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

`workflows/lanes.ts` fixes the versioned loop/turn step sequence. Each action is one
paid model slice with retries disabled. `betweenSlices` keeps its version-1
sequence; notes and hooks are consumed inside `agentStep` without new journal
entries. Loops rotate after a bounded number of turns/doorbells to keep the
8 MiB journal bounded; old completed loops are cleaned up.

`receipts.effects.purge` runs a single scheduled chain while the ledger is nonempty,
removing at most `LIMITS.purgeBatch` indexed expired rows per mutation. No table
mirrors Workflow/Workpool internals. `agevex/test` mounts extra inspection
functions only inside the test harness to verify and replay real journals.
