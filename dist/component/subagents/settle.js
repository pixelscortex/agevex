/**
 * Settling a delegated run: the settlement fence, the R3 invariant, and the
 * registered `settlementContext`, `settle` and `escalate` endpoints.
 *
 * A child run may become terminal only when nothing can still produce work
 * for it: no ready inbox row, no pending descendant delivery, no unjoined
 * wait-"all" member (`settlementBlocked`). An idle child whose last blocker
 * clears settles from its recorded, host-verified last-turn outcome
 * (`settleIdleParent`, "R3") and notifies the host coordinator to deliver the
 * result upward. Called by wake, finish/failure paths, `settle`, `escalate`
 * and group release. Touches `subagentRuns` and the root's `activeRuns`;
 * reads `inbox` and `assignments`.
 */
import { internal } from "../_generated/api.js";
import { mutation, query, internalMutation, } from "../_generated/server.js";
import { firstReady } from "../turns/inbox.js";
import { appendEvent, isSettled, runById } from "./runs.js";
import { v } from "convex/values";
import { runErrorCode } from "../schema.js";
import { settlementScope } from "./views.js";
/** Every non-terminal child retains deliveryStatus=pending; delivery can only
 * change after settlement. One indexed existence probe therefore covers live
 * descendants AND the terminal-to-delivery gap. The fence is transitive because
 * a child obeys the same rule before settling. No history scan is needed.
 */
export async function hasPendingChildren(ctx, parent, includeSide = false) {
    const ordinary = !!(await ctx.db
        .query("subagentRuns")
        .withIndex("by_parent_delivery", (q) => q.eq("actorAssignmentId", parent._id).eq("side", undefined).eq("deliveryStatus", "pending"))
        .first());
    if (ordinary || !includeSide)
        return ordinary;
    return !!(await ctx.db
        .query("subagentRuns")
        .withIndex("by_parent_delivery", (q) => q.eq("actorAssignmentId", parent._id).eq("side", true).eq("deliveryStatus", "pending"))
        .first());
}
/** A terminal child whose native delivery has not committed is also future
 * inbox work. Fence that short settlement/delivery interval and unreleased
 * groups as well as live descendants; otherwise a result could reach a terminal
 * parent. Five indexed existence probes (<=3 KiB inbox + 4*4 KiB runs)
 * + one <=34 KiB root
 * read total <=53 KiB; no history is read.
 */
export async function settlementBlocked(ctx, parent) {
    if (await firstReady(ctx, parent._id))
        return true;
    if (await hasPendingChildren(ctx, parent))
        return true;
    const root = parent.rootAssignmentId
        ? await ctx.db.get("assignments", parent.rootAssignmentId)
        : parent;
    if (!root)
        return false;
    // Any not-yet-joined wait "all" member of this epoch fences settlement. One
    // exact probe per unjoined state, rather than a range over the join literal
    // order, so a renamed state can never silently fall outside the fence.
    for (const join of ["open", "sealed", "ready"])
        if (await ctx.db
            .query("subagentRuns")
            .withIndex("by_join", (q) => q
            .eq("actorAssignmentId", parent._id)
            .eq("rootCancellationEpoch", root.cancellationEpoch)
            .eq("join", join))
            .first())
            return true;
    return false;
}
/** Move a live run to its terminal status if its child is not fenced, release
 * the root's active slot, and re-check R3 on the ordinary parent. Returns
 * false (writing nothing) when already terminal or still blocked;
 * `settleIdleParent` and escalate rely on that to notify exactly once
 * (`recordTurnOutcome` ignores it: its settle only records the outcome). */
export async function settleRunState(ctx, run, status, errorCode, childResultMessageId) {
    if (isSettled(run.status))
        return false;
    const child = run.childAssignmentId
        ? await ctx.db.get("assignments", run.childAssignmentId)
        : null;
    if (child && (await settlementBlocked(ctx, child)))
        return false;
    const at = Date.now();
    await ctx.db.patch("subagentRuns", run._id, {
        status,
        errorCode,
        // Only idle settlement reads the deferred outcome, and only before the run
        // is terminal; a terminal run never needs it again.
        lastTurnResult: undefined,
        ...(childResultMessageId ? { childResultMessageId } : {}),
        events: appendEvent(run.events, status, at, errorCode),
    });
    const root = await ctx.db.get("assignments", run.rootAssignmentId);
    if (root) {
        await ctx.db.patch("assignments", root._id, {
            activeRuns: Math.max(0, root.activeRuns - 1),
        });
    }
    // Side reviews never hold their watched parent behind R3, so their
    // settlement cannot clear an R3 blocker either. Only ordinary descendants
    // propagate this re-check; otherwise a best-effort review could finalize
    // an idle watched run before its own verified outcome is ready.
    if (!run.side) {
        const parent = await ctx.db.get("assignments", run.actorAssignmentId);
        if (parent)
            await settleIdleParent(ctx, parent);
    }
    return true;
}
/** Schedule the host coordinator's delivery of a newly terminal run. The
 * notify action runs outside this transaction and records a failed delivery
 * if the coordinator throws. */
export async function scheduleNotify(ctx, run) {
    await ctx.scheduler.runAfter(0, internal.subagents.deliver.notify, {
        runId: run.runId,
        deliveryToken: run.deliveryToken,
        coordinateHandle: run.coordinateHandle,
    });
}
/** R3 is an invariant, not just a turn-end check. Delivery failure and an
 * empty join can remove the last blocker without creating another turn. Use
 * only the host-verified outcome recorded by settle; a native save alone is
 * not proof that the last turn reported a valid result. The same notification
 * path propagates the terminal outcome to the next ancestor without paid work.
 * Depth <=2 bounds propagation to at most 2 * (6*34 KiB assignment reads +
 * 2*4 KiB run reads + 19 KiB indexed fence probes) <=462 KiB metadata,
 * including patch reads and the watched thread's context references. No native
 * bodies are read here; side settlement never enters this ancestor path.
 * Returns true when the child's run is (now) terminal.
 */
export async function settleIdleParent(ctx, parent) {
    if (parent.cancelled || parent.turnStatus !== "idle" || !parent.childRunId)
        return false;
    const run = await runById(ctx, parent.childRunId);
    if (!run || run.status === "asking")
        return false;
    if (isSettled(run.status))
        return true;
    const root = await ctx.db.get("assignments", run.rootAssignmentId);
    if (!root || root.cancelled || root.cancellationEpoch !== run.rootCancellationEpoch)
        return false;
    const result = run.lastTurnResult;
    const errorCode = result?.errorCode ?? (result?.messageId ? null : "RESULT_UNVERIFIED");
    const settled = await settleRunState(ctx, run, errorCode ? "failed" : "completed", errorCode, result?.messageId);
    if (!settled)
        return false;
    await scheduleNotify(ctx, run);
    return true;
}
/** `subagents.settle.settle`: record the host-verified outcome of a child's turn and
 * settle its run if nothing fences settlement. A fenced outcome waits on the
 * run (R3 settles it later from `lastTurnResult`). Only the turn that owns
 * the token may report; anything else is FORBIDDEN. */
export async function recordTurnOutcome(ctx, args) {
    const child = await ctx.db.get("assignments", args.assignmentId);
    if (!child || child.childRunId !== args.runId || child.turnToken !== args.turnToken)
        throw new Error("FORBIDDEN");
    // A released or escalated turn cannot report an outcome any more.
    if (child.cancelled || child.turnStatus !== "running")
        throw new Error("FORBIDDEN");
    const run = await runById(ctx, args.runId);
    if (!run || run.childAssignmentId !== child._id)
        throw new Error("FORBIDDEN");
    // Verification and the deferred outcome commit together, even while the
    // descendant fence holds. Claim clears this before any later turn starts.
    await ctx.db.patch("subagentRuns", run._id, {
        lastTurnResult: {
            ...(args.childResultMessageId ? { messageId: args.childResultMessageId } : {}),
            errorCode: args.errorCode,
        },
    });
    await settleRunState(ctx, run, args.errorCode ? "failed" : "completed", args.errorCode, args.childResultMessageId ?? undefined);
    return null;
}
/** `subagents.settle.escalate`: fail a live run after its child turn failed
 * terminally (turns/finish.ts failChild). Records the failure as the
 * last-turn outcome first, so a fenced run still fails once its blockers
 * clear; notifies only on the first successful settlement. */
export async function escalateRun(ctx, runId, code) {
    const run = await runById(ctx, runId);
    if (!run || isSettled(run.status))
        return null;
    await ctx.db.patch("subagentRuns", run._id, {
        lastTurnResult: { errorCode: code ?? "EXECUTION_AMBIGUOUS" },
    });
    const first = await settleRunState(ctx, run, "failed", code ?? "EXECUTION_AMBIGUOUS", undefined);
    if (!first)
        return null;
    await scheduleNotify(ctx, run);
    return null;
}
/** What a finishing child turn needs to verify and report its result: the
 * run, its recorded final message id and whether settlement is still fenced.
 * Null unless this exact token owns the running child turn of a live run;
 * see `settlementScope` in subagents/views.ts. */
export const settlementContext = query({
    args: {
        assignmentId: v.id("assignments"),
        turnToken: v.string(),
        runId: v.string(),
    },
    returns: v.union(v.null(), v.object({
        runId: v.string(),
        agent: v.string(),
        subject: v.string(),
        childThreadId: v.string(),
        childResultMessageId: v.union(v.string(), v.null()),
        blocked: v.boolean(),
    })),
    handler: (ctx, args) => settlementScope(ctx, args),
});
/** Record a child turn's host-verified outcome and settle its run when
 * nothing fences it; see `recordTurnOutcome`. */
export const settle = mutation({
    args: {
        assignmentId: v.id("assignments"),
        turnToken: v.string(),
        runId: v.string(),
        childResultMessageId: v.union(v.string(), v.null()),
        errorCode: runErrorCode,
    },
    returns: v.null(),
    handler: (ctx, args) => recordTurnOutcome(ctx, args),
});
/** Fail a live run after its child turn failed terminally. */
export const escalate = internalMutation({
    args: { runId: v.string(), errorCode: v.optional(runErrorCode) },
    returns: v.null(),
    handler: (ctx, args) => escalateRun(ctx, args.runId, args.errorCode),
});
