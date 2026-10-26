/**
 * Wait-"all" cohorts: sealing, readiness and release of joined results.
 *
 * A cohort is the set of `subagentRuns` one parent launched with the same
 * group name under one run budget. Its join state moves one way:
 * open (reserve) -> sealed (the launching slice ends, `sealGroups`) -> ready
 * (every member terminal and its delivery no longer pending: accepted, failed
 * or blocked, `markGroupReady`) -> joined (one inbox row carrying all
 * accepted results is published, `releaseGroup`). `releaseReadyCohort`
 * (`subagents.deliver.releaseGroups`) finds one ready cohort and releases it.
 * Called by turns/ slice ends (boundaries.ts, finish.ts), delivery, wake and
 * claim. Touches `subagentRuns.join`, `inbox` and the parent's counters.
 */
import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** Readiness belongs to one sealed cohort, never a prefix of historical runs.
 * One representative is sufficient for indexed discovery; release marks every
 * member together. Membership is immutable after continueTurn/finish seals it.
 */
export declare function markGroupReady(ctx: MutationCtx, members: Doc<"subagentRuns">[], root: Doc<"assignments">): Promise<void>;
/** Release uses recorded parent-message ids only. Full inboxes defer this
 * control transition until wake observes a freed slot; native delivery is
 * already committed and is NEVER attempted again. Returns true when the
 * cohort was joined (with or without a published inbox row).
 */
export declare function releaseGroup(ctx: MutationCtx, parent: Doc<"assignments">, root: Doc<"assignments">, members: Doc<"subagentRuns">[]): Promise<boolean>;
/** A fast child may settle between two tool calls in the same model slice.
 * Seal only at that slice's existing completion mutation, never at settlement.
 * There is only one running slice per assignment; all unsealed members of its
 * current run belong to it. <=50 launch rows *4 KiB plus <=50 patch reads
 * =400 KiB, <=100 reads/50 writes. The index excludes older request budgets
 * and already sealed cohorts; no transcript or Workflow journal is consulted.
 *
 * The range also pins the root's CURRENT epoch. That excludes nothing: an open
 * member from an older epoch can never share parent.runId with a running
 * parent. A cancel that bumps the epoch while a member of run R is still open
 * finds R either as root.runId (the root stays on R until a slice end seals R's
 * members: approval pauses and recovery_required both keep runId) or as the
 * runId of the member's still-active actor, and marks R cancelled; it also
 * idles that actor and deletes its ready inbox rows. Afterwards every path
 * that could enqueue ready work for R is fenced (reserve/continueAdmission by
 * R.cancelled; attach, delivery, post and release by the epoch), so no
 * assignment runs under R again and reserve refuses any new member of R.
 */
export declare function sealGroups(ctx: MutationCtx, parent: Doc<"assignments">): Promise<void>;
/** Ready-group recovery uses an exact indexed representative, then only that
 * cohort's <=15 members (<=64 KiB + fixed assignment metadata). Old incomplete
 * groups never enter this range. Release one cohort per wake; remaining ready
 * cohorts are serviced by the next claim/finish without a scheduled sweep.
 * `parentRunId` restricts the search to one run (claim's same-run merge).
 * Returns true when a cohort was released. */
export declare function releaseReadyCohort(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    parentRunId?: Id<"runs">;
}): Promise<boolean>;
