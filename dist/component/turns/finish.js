/**
 * Ending a turn: `finish`, and the failure paths shared by the watchdog
 * (`stalled`), dispatch failure (`ambiguous`/`failWorkflow`), an
 * approval-limit rejection in `write` and a corrupt child claim.
 *
 * A failing child turn first tries `deferChildFailure`: if descendants or
 * inbox work still fence settlement, the failure is recorded on the run and
 * the child idles instead of escalating. Otherwise the assignment becomes
 * `recovery_required` and the child's run is escalated to a failed
 * settlement (`subagents.settle.escalate`). Paid generations are never retried.
 * Touches `assignments`, `inbox` (the reserved head / staged continuation)
 * and, via escalate, `subagentRuns`.
 */
import { internal } from "../_generated/api.js";
import { settlementBlocked } from "../subagents/settle.js";
import { sealGroups } from "../subagents/groups.js";
import { disarmRecovery } from "./recovery.js";
import { disarmSlice } from "./boundaries.js";
import { wake } from "./wake.js";
/** End the running turn `turnToken`: success idles the thread and wakes
 * queued work; a failure code is deferred behind the settlement fence
 * (children) or parks the thread in recovery_required. Either way the slice
 * is disarmed and the turn's open wait cohorts are sealed first. */
export async function finishTurn(ctx, args) {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.cancelled || row.turnToken !== args.turnToken || row.turnStatus !== "running")
        return null;
    await disarmSlice(ctx, row);
    await sealGroups(ctx, row);
    if (args.errorCode && (await deferChildFailure(ctx, row, args.errorCode)))
        return null;
    if (args.errorCode) {
        await failChild(ctx, row, args.errorCode);
        await markRecoveryRequired(ctx, row, args.errorCode);
    }
    else {
        await ctx.db.patch("assignments", row._id, {
            turnStatus: "idle",
            turnToken: undefined,
            promptMessageId: undefined,
        });
        await wake(ctx, { ...row, turnStatus: "idle" });
    }
    return null;
}
/** The slice watchdog fired. Detection only: never reassign an expired
 * token or replay a generation. Escalates only if the watchdog's own slice
 * is still the active one. */
export async function detectStall(ctx, args) {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row ||
        row.cancelled ||
        row.turnToken !== args.turnToken ||
        row.turnStatus !== "running" ||
        // The active slice is the armed watchdog's: claim writes lastSlice (or
        // none for a first slice keyed by its token) with watchdogId, and only
        // disarmSlice clears it. A newer slice's watchdog never matches here.
        !row.watchdogId ||
        (row.lastSlice ?? row.turnToken) !== (args.sliceId ?? args.turnToken))
        return null;
    if (await deferChildFailure(ctx, row))
        return null;
    await markRecoveryRequired(ctx, row, "EXECUTION_AMBIGUOUS");
    await disarmSlice(ctx, row);
    await failChild(ctx, row, "EXECUTION_AMBIGUOUS");
    return null;
}
/** Park the assignment for operator recovery with a typed error code. No
 * turn runs again until the host recovers it; wake ignores such rows. */
export async function markRecoveryRequired(ctx, row, code) {
    await ctx.db.patch("assignments", row._id, {
        turnStatus: "recovery_required",
        errorCode: code,
    });
}
/** A failed turn also obeys the run fence. A later descendant delivery may
 * continue the run, but this failed paid generation is never retried. Clear its
 * token so any late native writes lose ownership before waking queued work.
 * Returns true when the failure was deferred (the caller must not escalate).
 */
export async function deferChildFailure(ctx, row, code = "EXECUTION_AMBIGUOUS") {
    if (!row.childRunId || !(await settlementBlocked(ctx, row)))
        return false;
    // Persist the failed last-turn outcome before releasing its execution token.
    // Escalation obeys the same fence, so it cannot settle over pending work.
    await failChild(ctx, row, code);
    await disarmSlice(ctx, row);
    await sealGroups(ctx, row);
    // A continuation staged by afterTurn (continueAdmission) is consumed only by
    // the next slice's claim, which this failure just forfeited. Left behind, the
    // row stays out of the ready range and wake would overwrite inboxId with the
    // next ready row, orphaning it; cancel would then delete that ready row twice
    // (once as the "staged continuation", once in its ready loop) and throw.
    // Delete it here, as cancel does, and drop both pointers.
    if (row.hookContinue && row.inboxId)
        await ctx.db.delete("inbox", row.inboxId);
    await ctx.db.patch("assignments", row._id, {
        turnStatus: "idle",
        turnToken: undefined,
        promptMessageId: undefined,
        ...(row.hookContinue ? { hookContinue: false, inboxId: undefined } : {}),
        errorCode: null,
    });
    await wake(ctx, (await ctx.db.get("assignments", row._id)));
    return true;
}
/** All terminal child failures share the idempotent settlement/notification
 * path (`subagents.settle.escalate`). A no-op for roots. */
export async function failChild(ctx, row, code) {
    if (!row.childRunId)
        return null;
    await ctx.runMutation(internal.subagents.settle.escalate, {
        runId: row.childRunId,
        errorCode: code,
    });
    return null;
}
/** The dispatch of `turnToken` failed with an unknown outcome (the host action
 * threw, or its workflow failed). Called by `turns.failures.ambiguous` and
 * `turns.failures.failWorkflow`. The token/status fence makes duplicates no-ops; the
 * paid generation is never retried. */
export async function markAmbiguous(ctx, assignmentId, turnToken) {
    const row = await ctx.db.get("assignments", assignmentId);
    if (!row ||
        row.cancelled ||
        row.turnToken !== turnToken ||
        (row.turnStatus !== "queued" && row.turnStatus !== "running"))
        return null;
    // wake already removed the reserved head from queuedMessages. A dispatch
    // that fails before claim must retire that exact row without decrementing
    // again; otherwise the fence mistakes it for pending work and wake reserves
    // the same head a second time. The token/status fence makes duplicates no-ops.
    if (row.turnStatus === "queued" && row.inboxId) {
        const head = await ctx.db.get("inbox", row.inboxId);
        if (head)
            await ctx.db.delete("inbox", head._id);
        await ctx.db.patch("assignments", row._id, { inboxId: undefined });
        row.inboxId = undefined;
    }
    if (await deferChildFailure(ctx, row))
        return null;
    await markRecoveryRequired(ctx, row, "EXECUTION_AMBIGUOUS");
    await disarmSlice(ctx, row);
    await disarmRecovery(ctx, row);
    await failChild(ctx, row, "EXECUTION_AMBIGUOUS");
    return null;
}
