/**
 * The recovery check: one scheduled `turns.loop.reconcile` per assignment that has
 * durable inbox work but no running turn.
 *
 * wake arms or disarms it after every publish; claim, cancel and approval
 * pauses retire it; `turns.loop.reconcile` re-rings a loop whose awaited ping was
 * lost and backs off otherwise. Idle deployments schedule nothing, so this is
 * never a perpetual chain. Touches `assignments` (recovery fields, `pinged`)
 * and reads the ready `inbox` range. Also home of `cancelIfPending`, the
 * shared "retire my own scheduled job" step used by slice watchdogs too.
 */
import { approvalBlocked } from "../approvals.js";
import { internal } from "../_generated/api.js";
import { LIMITS } from "../limits.js";
import { firstReady } from "./inbox.js";
/** Cancel a scheduled job only while it is still pending. A job that is
 * already running (for example the watchdog or reconcile invoking this very
 * transaction) owns itself and must not be cancelled. */
export async function cancelIfPending(ctx, jobId) {
    const job = await ctx.db.system.get(jobId);
    if (job?.state.kind === "pending")
        await ctx.scheduler.cancel(jobId);
}
/**
 * Keep exactly one check while durable inbox work has no running turn. The
 * Workflow completion callback can lag next's committed loopWaiting flag by
 * longer than a check interval, so neither that flag nor pinged owns recovery.
 * Its scheduler id lets claim/cancel/block retire the check transactionally;
 * idle deployments need no sweep and busy generations must never be re-rung.
 */
export async function armRecovery(ctx, row, delayMs = LIMITS.reconcileIntervalMs) {
    if (row.recoveryAt !== undefined)
        return;
    const recoveryAt = Date.now() + delayMs;
    const recoveryJobId = await ctx.scheduler.runAt(recoveryAt, internal.turns.loop.reconcile, {
        assignmentId: row._id,
        recoveryAt,
    });
    await ctx.db.patch("assignments", row._id, {
        recoveryAt,
        recoveryJobId,
        recoveryDelayMs: delayMs,
    });
}
/** Retire the check and reset the doorbell flag. Called whenever the
 * assignment has no claimable work, or a turn/cancel/pause takes ownership. */
export async function disarmRecovery(ctx, row) {
    if (row.recoveryJobId)
        await cancelIfPending(ctx, row.recoveryJobId);
    await ctx.db.patch("assignments", row._id, {
        recoveryAt: undefined,
        recoveryJobId: undefined,
        recoveryDelayMs: undefined,
        pinged: false,
    });
}
/** Whether ready work is waiting with nothing able to run it: not cancelled,
 * not paused for approvals, no running turn and no recovery escalation, but a
 * ready inbox row exists. One indexed probe. */
export async function needsRecovery(ctx, row) {
    if (row.cancelled ||
        approvalBlocked(row) ||
        row.turnStatus === "running" ||
        row.turnStatus === "recovery_required")
        return false;
    return !!(await firstReady(ctx, row._id));
}
/** The capped exponential delay for the next check after one found the loop
 * not yet awaiting its ping. */
export function nextRecoveryDelay(row) {
    return Math.min((row.recoveryDelayMs ?? LIMITS.reconcileIntervalMs) * 2, LIMITS.reconcileMaxIntervalMs);
}
