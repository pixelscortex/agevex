# Component ownership

Mount `agevex/convex.config` beside the host's native Agent component.
Agevex internally mounts two Workflow components, each with its own nested
Workpool: root parallelism 2, child parallelism 4. Hosts export `runTurn` and
`coordinate`; no host Workflow exports are required.

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

Transcripts, tasks and result bodies stay in Agent. Workflow owns journals,
events, nested-workflow cancellation and work dispatch. `queue.write` wraps
native/tool mutations in the execution/epoch check within one transaction;
checking in an action alone would race with cancellation.

`workflows.ts` fixes the versioned loop/turn step sequence. Each action is one
paid model slice with retries disabled. `betweenSlices` keeps its version-1
sequence; notes and hooks are consumed inside `agentStep` without new journal
entries. Loops rotate after a bounded number of turns/doorbells to keep the
8 MiB journal bounded; old completed loops are cleaned up.

`ledger.purge` runs a single scheduled chain while the ledger is nonempty,
removing at most `LIMITS.purgeBatch` indexed expired rows per mutation. No table
mirrors Workflow/Workpool internals. `agevex/test` mounts extra inspection
functions only inside the test harness to verify and replay real journals.
