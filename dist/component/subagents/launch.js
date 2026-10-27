/**
 * Launching a delegation: the trusted `delegateContext` of a running turn,
 * admission (`reserve`) and attaching the native child thread (`attach`).
 *
 * `reserveRun` checks the turn token, live root and parent epoch, depth,
 * tool-call idempotency, active-child capacity, run budget and outstanding
 * result headroom across requests. Success spends the budget and
 * inserts the queued run in the same transaction as the host's native
 * child-thread creation. `attachChild` then creates the child assignment with
 * its task as the first inbox row and wakes it. Touches `subagentRuns`,
 * `runs`, `assignments`, `inbox` and the root's delegation counters.
 */
import { v } from "convex/values";
import { mutation, query } from "../_generated/server.js";
import { denialCode } from "../schema.js";
import { assertFunctionHandle, assertName } from "../facts.js";
import { approvalKey } from "../approvals.js";
import { assertRunMetadata, newSubagentRun, runById } from "./runs.js";
import { newChildAssignment } from "../turns/assignments.js";
import { wake } from "../turns/wake.js";
import { delegateScope } from "./views.js";
import { canOweResult, reserveFor } from "./headroom.js";
const reserveArgs = {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    toolCallId: v.string(),
    agent: v.string(),
    payloadFingerprint: v.string(),
    coordinateHandle: v.string(),
};
const reservation = v.union(v.object({ kind: v.literal("reserved"), runId: v.string() }), v.object({ kind: v.literal("replay"), runId: v.string(), agent: v.string() }), v.object({ kind: v.literal("denied"), code: denialCode }));
const denied = (code) => ({ kind: "denied", code });
/**
 * Reservation, run-budget spend and active-child count commit with the host's
 * native child thread creation. Dedup precedes admission limits so a repeated
 * callback can recover its original receipt even at capacity. Result turns
 * retain the originating user run; only a new user prompt creates new budget.
 * Root counters include every descendant. Depth is checked from the immediate
 * parent run, so a shared child definition cannot bypass the configured bound.
 */
async function reserveRun(ctx, args) {
    // The agent name becomes the child assignment's `agent`; the handle is
    // stored on the run row. Bound both before any read or write.
    assertName(args.agent, "agent");
    assertFunctionHandle(args.coordinateHandle, "coordinateHandle");
    const scope = await reservationScope(ctx, args);
    if (scope.kind === "denied")
        return scope;
    const { row, root, depth } = scope;
    const dedupKey = `${row._id}:${args.turnToken}:${await approvalKey(args.toolCallId)}`;
    const duplicate = await ctx.db
        .query("subagentRuns")
        .withIndex("by_dedup", (q) => q.eq("dedupKey", dedupKey))
        .unique();
    if (duplicate) {
        if (duplicate.payloadFingerprint !== args.payloadFingerprint)
            return denied("DELEGATION_CONFLICT");
        return { kind: "replay", runId: duplicate._id, agent: duplicate.agent };
    }
    if (root.activeRuns >= root.limits.activeChildrenPerRoot)
        return denied("ACTIVE_LIMIT");
    // A delivered-result turn retains this run id: completing a child cannot
    // replenish launches, and a new caller prompt alone creates a new budget.
    const budget = row.runId ? await ctx.db.get("runs", row.runId) : null;
    if (!budget || budget.cancelled || budget.launches >= row.limits.runLaunches)
        return denied("RUN_BUDGET");
    const refusal = await reserveFor(ctx, "launch", root, budget);
    if (refusal)
        return refusal;
    if (!(await canOweResult(ctx, row, root)))
        return denied("RESULTS_PENDING");
    await ctx.db.patch("runs", budget._id, {
        launches: budget.launches + 1,
        hops: budget.hops + 1,
    });
    const now = Date.now();
    const sequence = root.nextRunSequence + 1;
    const runId = await ctx.db.insert("subagentRuns", newSubagentRun({
        request: args,
        actor: row,
        root,
        budget,
        depth,
        dedupKey,
        sequence,
        now,
    }));
    await ctx.db.patch("assignments", root._id, {
        activeRuns: root.activeRuns + 1,
        nextRunSequence: sequence,
    });
    return { kind: "reserved", runId };
}
/** The checks that need no dedup key: the calling turn still owns its token,
 * the root (and, for a child caller, its own running run) is live in the
 * root's epoch and the depth bound holds. */
async function reservationScope(ctx, args) {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.turnToken !== args.turnToken || row.turnStatus !== "running")
        return denied("STALE_TURN");
    const root = row.rootAssignmentId ? await ctx.db.get("assignments", row.rootAssignmentId) : row;
    const parent = row.childRunId ? await runById(ctx, row.childRunId) : null;
    if (row.cancelled ||
        !root ||
        root.cancelled ||
        (row.childRunId &&
            (!parent ||
                parent.status !== "running" ||
                parent.rootCancellationEpoch !== root.cancellationEpoch)))
        return denied("FORBIDDEN");
    const depth = parent ? parent.depth + 1 : 1;
    if (depth > root.limits.maxDepth)
        return denied("DEPTH_LIMIT");
    return { kind: "scope", row, root, depth };
}
const attachArgs = {
    runId: v.string(),
    childThreadId: v.string(),
    promptMessageId: v.string(),
};
/**
 * Queue a native child in its independent lane. Keeping the task in Agent and
 * only the message id in the inbox avoids placing task bodies in Workflow's
 * 800 KiB step values. The parent's short launch mutation never waits for a
 * child action, leaving scheduler capacity available for those children.
 * Idempotent: an already attached run is a no-op.
 */
async function attachChild(ctx, args) {
    const run = await runById(ctx, args.runId);
    if (!run || run.childAssignmentId)
        return null;
    if (run.status !== "queued")
        throw new Error("INVALID_LAUNCH");
    const root = await ctx.db.get("assignments", run.rootAssignmentId);
    if (!root || root.cancelled || root.cancellationEpoch !== run.rootCancellationEpoch)
        throw new Error("ROOT_UNAVAILABLE");
    const childId = await ctx.db.insert("assignments", newChildAssignment({
        root,
        run,
        childThreadId: args.childThreadId,
    }));
    await ctx.db.insert("inbox", {
        assignmentId: childId,
        messageId: args.promptMessageId,
        sequence: 0,
        kind: "user",
        runId: run.parentRunId,
    });
    const attached = {
        taskMessageId: args.promptMessageId,
        childAssignmentId: childId,
        childThreadId: args.childThreadId,
    };
    assertRunMetadata({ ...run, ...attached });
    await ctx.db.patch("subagentRuns", run._id, attached);
    await wake(ctx, (await ctx.db.get("assignments", childId)));
    return null;
}
/** Trusted root context for a running turn that wants to delegate. */
export const delegateContext = query({
    args: { assignmentId: v.id("assignments"), turnToken: v.string() },
    returns: v.union(v.null(), v.object({
        rootAssignmentId: v.string(),
        rootThreadId: v.string(),
        subject: v.string(),
        rootAgent: v.string(),
        actorAgent: v.string(),
        activeRuns: v.number(),
    })),
    handler: (ctx, args) => delegateScope(ctx, args),
});
/** Admit one delegation and spend its budget; see `reserveRun`. */
export const reserve = mutation({
    args: reserveArgs,
    returns: reservation,
    handler: (ctx, args) => reserveRun(ctx, args),
});
/** Create the child assignment for a reserved run's native thread and queue
 * its task; see `attachChild`. */
export const attach = mutation({
    args: attachArgs,
    returns: v.null(),
    handler: (ctx, args) => attachChild(ctx, args),
});
