import { internal } from "../_generated/api.js";
import { mutation } from "../_generated/server.js";
import { appendEvent } from "../subagents/runs.js";
import { childLane, rootLane } from "../workflows/lanes.js";
import { readyRows } from "./inbox.js";
import { cancelIfPending } from "./recovery.js";
import { readyRowLimit } from "../limits.js";
import { RUN_LIMITS } from "../run_settings.js";
import { v } from "convex/values";
/** Cancel the root thread owned by `subject` and all its live descendants.
 * Returns the affected native threads so the host can abort their streams. */
async function cancelRoot(ctx, args) {
    const root = await ctx.db.get("assignments", args.assignmentId);
    if (!root || root.subject !== args.subject || root.childRunId)
        throw new Error("FORBIDDEN");
    const children = await liveChildren(ctx, root);
    const affected = [
        root,
        ...(await Promise.all(
        // Promise.all accepts null placeholders for children without assignments.
        // eslint-disable-next-line typescript/await-thenable
        children.map((run) => run.childAssignmentId ? ctx.db.get("assignments", run.childAssignmentId) : null))).filter((row) => row !== null),
    ];
    const runIds = new Set();
    for (const row of affected) {
        await cancelAssignment(ctx, row, runIds);
    }
    if (runIds.size > RUN_LIMITS.cancelBudgets)
        throw new Error("CANCEL_RUN_BUDGET");
    // <=168 distinct runs *2*16 KiB <5.25 MiB for terminal guard + live patch.
    // Deduplicate across assignments: every child belongs to one root budget.
    for (const runId of runIds) {
        const run = await ctx.db.get("runs", runId);
        // Terminal outcomes stay immutable; cancellation fences only live work.
        if (run && run.finishedAt === undefined)
            await ctx.db.patch("runs", runId, { cancelled: true, finishedAt: Date.now() });
    }
    for (const run of children) {
        await ctx.db.patch("subagentRuns", run._id, {
            status: "failed",
            deliveryStatus: "blocked",
            errorCode: "ROOT_UNAVAILABLE",
            lastTurnResult: undefined,
            // No delivery event: a blocked delivery ends with this terminal event,
            // which is where `runTimes` reads its deliveryAt.
            events: appendEvent(run.events, "failed", Date.now(), "ROOT_UNAVAILABLE"),
        });
    }
    await ctx.db.patch("assignments", root._id, {
        activeRuns: 0,
    });
    return affected.map((row) => ({ threadId: row.threadId, agent: row.agent }));
}
/** Every queued, running or asking delegation under this root: three exact
 * status ranges, each capped at the root's active-children bound. */
async function liveChildren(ctx, root) {
    return (await Promise.all(["queued", "running", "asking"].map((status) => ctx.db
        .query("subagentRuns")
        .withIndex("by_root_status", (q) => q.eq("rootAssignmentId", root._id).eq("status", status))
        .take(root.limits.activeChildrenPerRoot)))).flat();
}
/** Fence and idle one assignment, then drop its ready work. `row` is the
 * pre-cancel snapshot: the pending generation, notes,
 * run and workflow it names are the ones cleaned up here. */
async function cancelAssignment(ctx, row, runIds) {
    if (row.watchdogId)
        await cancelIfPending(ctx, row.watchdogId);
    if (row.recoveryJobId)
        await cancelIfPending(ctx, row.recoveryJobId);
    const approvalCleanup = !!row.approvals?.requests.length;
    await ctx.db.patch("assignments", row._id, cancelledState(row, approvalCleanup));
    // Only ready rows are read here. Raw passive bodies are cleared by one
    // bounded job per assignment, preserving the documented <16 MiB cancel ceiling.
    const inbox = await readyRows(ctx, row._id, readyRowLimit(row.limits));
    await scheduleCleanup(ctx, row, approvalCleanup);
    for (const item of inbox) {
        runIds.add(item.runId);
        // Retain only the exact-id label of saved progress, as claim does. It is
        // no longer ready work and carries no body or new cancellation budget.
        if (item.kind === "note" && item.from)
            await ctx.db.patch("inbox", item._id, { passive: false });
        else
            await ctx.db.delete("inbox", item._id);
    }
    if (row.runId)
        runIds.add(row.runId);
    if (row.workflowId)
        await (row.childRunId ? childLane : rootLane).cancel(ctx, row.workflowId);
}
/** The cancelled, idle state: a new epoch fences every late write, all turn
 * and queue state is cleared, and a recorded approval pause stays blocked
 * (`cleanupPending`) until cancellation cleanup has denied each request. */
function cancelledState(row, approvalCleanup) {
    return {
        cancelled: true,
        activeTools: undefined,
        cancellationEpoch: row.cancellationEpoch + 1,
        turnStatus: "idle",
        errorCode: null,
        turnToken: undefined,
        watchdogId: undefined,
        recoveryAt: undefined,
        recoveryJobId: undefined,
        recoveryDelayMs: undefined,
        promptMessageId: undefined,
        inboxId: undefined,
        workflowId: undefined,
        loopWaiting: false,
        pinged: false,
        queuedMessages: 0,
        notesPending: 0,
        approvals: approvalCleanup ? { ...row.approvals, cleanupPending: true } : undefined,
    };
}
/** Hand the out-of-budget cleanup to finite jobs: unsaved note bodies of the
 * old epoch (hooks.notes.cancelNotes) and the pending placeholder/stream plus
 * approval denials (cancellation.cleanup.cleanup). */
async function scheduleCleanup(ctx, row, approvalCleanup) {
    if (row.notesPending)
        await ctx.scheduler.runAfter(0, internal.hooks.notes.cancelNotes, {
            assignmentId: row._id,
            epoch: row.cancellationEpoch,
        });
    if (row.pendingGeneration || approvalCleanup)
        await ctx.scheduler.runAfter(0, internal.cancellation.cleanup.cleanup, {
            assignmentId: row._id,
            pending: row.pendingGeneration,
            approvalEpoch: approvalCleanup ? row.approvals.epoch : undefined,
        });
}
/** Cancel sets fences before canceling Workflow, which cannot abort actions.
 * See `cancelRoot`. */
export const cancel = mutation({
    args: { assignmentId: v.id("assignments"), subject: v.string() },
    returns: v.array(v.object({ threadId: v.string(), agent: v.string() })),
    handler: (ctx, args) => cancelRoot(ctx, args),
});
