# Component ownership

Mount `agevex/convex.config` beside the host's native Agent component.
Agevex internally mounts two Workflow components, each with its own nested
Workpool: root parallelism 2, child parallelism 4. Hosts export `runTurn` and
`coordinate`; no host Workflow exports are required.

- `assignments`: ownership, native thread references, workflow id, current run,
  one execution token and cancellation epoch.
- `inbox`: FIFO native message references and kinds. Only `user` and `result`
  are produced in Phase 1a. A reserved row stays here until claim, so approvals
  can block generation without losing work.
- `runs`: one accepted user request and all caused work; launch/hop counters,
  cancellation and outstanding result deliveries.
- `receipts`: one shared `(scope, key)` ledger for request acceptance and tools;
  input fingerprint, claim fence, lease, status, bounded result and TTL.
- `subagentRuns`: child linkage, verified native result reference, root epoch,
  delivery capability and bounded transition history.

Transcripts, tasks and result bodies stay in Agent. Workflow owns journals,
events, nested-workflow cancellation and work dispatch. `queue.write` wraps
native/tool mutations in the execution/epoch check within one transaction;
checking in an action alone would race with cancellation.

`workflows.ts` fixes the versioned loop/turn step sequence. Each action is one
paid model slice with retries disabled. `betweenSlices` is the seam for future
notes/hooks. Loops rotate after a bounded number of turns/doorbells to keep the
8 MiB journal bounded; old completed loops are cleaned up.

`ledger.purge` runs a single scheduled chain while the ledger is nonempty,
removing at most `LIMITS.purgeBatch` indexed expired rows per mutation. No table
mirrors Workflow/Workpool internals. `agevex/test` mounts extra inspection
functions only inside the test harness to verify and replay real journals.
