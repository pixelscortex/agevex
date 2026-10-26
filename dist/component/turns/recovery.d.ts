import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** Cancel a scheduled job only while it is still pending. A job that is
 * already running (for example the watchdog or reconcile invoking this very
 * transaction) owns itself and must not be cancelled. */
export declare function cancelIfPending(ctx: MutationCtx, jobId: Id<"_scheduled_functions">): Promise<void>;
/**
 * Keep exactly one check while durable inbox work has no running turn. The
 * Workflow completion callback can lag next's committed loopWaiting flag by
 * longer than a check interval, so neither that flag nor pinged owns recovery.
 * Its scheduler id lets claim/cancel/block retire the check transactionally;
 * idle deployments need no sweep and busy generations must never be re-rung.
 */
export declare function armRecovery(ctx: MutationCtx, row: Doc<"assignments">, delayMs?: number): Promise<void>;
/** Retire the check and reset the doorbell flag. Called whenever the
 * assignment has no claimable work, or a turn/cancel/pause takes ownership. */
export declare function disarmRecovery(ctx: MutationCtx, row: Doc<"assignments">): Promise<void>;
/** Whether ready work is waiting with nothing able to run it: not cancelled,
 * not paused for approvals, no running turn and no recovery escalation, but a
 * ready inbox row exists. One indexed probe. */
export declare function needsRecovery(ctx: MutationCtx, row: Doc<"assignments">): Promise<boolean>;
/** The capped exponential delay for the next check after one found the loop
 * not yet awaiting its ping. */
export declare function nextRecoveryDelay(row: Doc<"assignments">): number;
