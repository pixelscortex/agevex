/** End turns and propagate child failures without replaying paid work.
 * Workflow completion calls the exact-id, fenced failure finalizer below.
 */
import { failCrashedGeneration } from "../cancellation/cleanup.js";
import { internal } from "../_generated/api.js";
import { settlementBlocked } from "../subagents/settle.js";
import { disarmSlice } from "./boundaries.js";
import { wake, firstClaimable } from "./wake.js";
import { endRootTurn } from "./run_lifecycle.js";
/** End the running turn `turnToken`: success idles the thread and wakes
 * queued work; a failure code is deferred behind the settlement fence
 * (children) or parks the thread in recovery_required. Either way the slice
 * is disarmed first. */
export async function finishTurn(ctx, args) {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.cancelled || row.turnToken !== args.turnToken || row.turnStatus !== "running")
        return null;
    await disarmSlice(ctx, row);
    if (args.errorCode && (await deferChildFailure(ctx, row, args.errorCode)))
        return null;
    if (args.errorCode) {
        await failChild(ctx, row, args.errorCode);
        await markRecoveryRequired(ctx, row, args.errorCode);
    }
    else {
        await endRootTurn(ctx, row, null);
        await ctx.db.patch("assignments", row._id, {
            turnStatus: "idle",
            turnToken: undefined,
            promptMessageId: undefined,
        });
        await wake(ctx, { ...row, turnStatus: "idle" });
    }
    return null;
}
/** Park the assignment for operator recovery with a typed error code. No
 * turn runs again until the host recovers it; wake ignores such rows. */
export async function markRecoveryRequired(ctx, row, code) {
    await endRootTurn(ctx, row, code);
    await ctx.db.patch("assignments", row._id, {
        activeTools: undefined,
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
    await ctx.db.patch("assignments", row._id, {
        turnStatus: "idle",
        turnToken: undefined,
        promptMessageId: undefined,
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
/** Finalize an unknown paid outcome exactly once, fenced by loop, token and
 * epoch. Exact native ids avoid transcript scans and stream materialization.
 * Settlement adds <=222 KiB at maximum depth; root admission retires at most
 * 152 failed-request controls. The full callback stays below 7,600 KiB reads.
 * Native cleanup runs first in this transaction so failure cannot publish a
 * terminal turn with a live placeholder. There is deliberately no fallback.
 */
export async function failWorkflow(ctx, args) {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row ||
        row.cancelled ||
        row.workflowId !== args.workflowId ||
        row.cancellationEpoch !== args.epoch ||
        row.turnToken !== args.executionId ||
        (row.turnStatus !== "queued" && row.turnStatus !== "running"))
        return null;
    const pending = row.pendingGeneration;
    if (pending && pending.executionId === args.executionId && pending.epoch === args.epoch) {
        await failCrashedGeneration(ctx, pending);
        await ctx.db.patch("assignments", row._id, { pendingGeneration: undefined });
    }
    // Admission already removed the reserved head from queuedMessages.
    if (row.turnStatus === "queued" && row.inboxId) {
        const head = await ctx.db.get("inbox", row.inboxId);
        if (head)
            await ctx.db.delete("inbox", head._id);
        await ctx.db.patch("assignments", row._id, { inboxId: undefined });
        row.inboxId = undefined;
    }
    if (row.runId)
        await ctx.db.patch("runs", row.runId, { usagePartial: true });
    await disarmSlice(ctx, row);
    if (await deferChildFailure(ctx, row))
        return null;
    await markRecoveryRequired(ctx, row, "EXECUTION_AMBIGUOUS");
    await failChild(ctx, row, "EXECUTION_AMBIGUOUS");
    await wakeUnrelated(ctx, row);
    return null;
}
/** A queued root request has its own run budget and may proceed after this
 * failed request. Same-run continuations stay parked: unknown paid work never
 * becomes a fresh execution through this handoff. Failed request metadata is
 * retired by the bounded ready-queue scan shared with future admission. */
async function wakeUnrelated(ctx, row) {
    if (row.childRunId)
        return;
    const next = await firstClaimable(ctx, row);
    if (!next || next.runId === row.runId)
        return;
    await ctx.db.patch("assignments", row._id, {
        turnStatus: "idle",
        turnToken: undefined,
        promptMessageId: undefined,
        errorCode: null,
    });
    await wake(ctx, (await ctx.db.get("assignments", row._id)));
}
