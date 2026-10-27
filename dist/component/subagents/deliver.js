/**
 * Delivering a terminal child's result to its parent thread: `notify`,
 * `deliveryContext`, `deliver` and `failDelivery`.
 *
 * `notify` asks the host coordinator to deliver; the coordinator reads
 * `deliveryContext`, saves the result natively in the parent thread and then
 * calls `deliver` (or `notify` records `failDelivery`). One delivery per run:
 * it records the outcome on the run, spends one hop of the shared budget for
 * accepted results, and enqueues the result as ready parent work or wakes
 * the parent to re-check settlement. Touches `subagentRuns`, `runs`, `inbox`
 * and the parent's counters.
 */
import { mutation, query, internalAction, internalMutation, } from "../_generated/server.js";
import { isSettled, runById, appendEvent } from "./runs.js";
import { wake } from "../turns/wake.js";
import { closeRootRun } from "../turns/run_lifecycle.js";
import { v } from "convex/values";
import { internal } from "../_generated/api.js";
import { runErrorCode } from "../schema.js";
import { deliveryContextFields, terminalContext } from "./views.js";
/** The event phase recorded for each delivery outcome. */
const deliveryPhase = {
    accepted: "result_accepted",
    failed: "delivery_failed",
    blocked: "delivery_blocked",
};
/** Each terminal delivery spends one hop and appends ready work immediately.
 * The delivery token is the capability; a repeated delivery is a no-op. */
export async function applyDelivery(ctx, args) {
    const run = await runById(ctx, args.runId);
    if (!run || run.deliveryToken !== args.deliveryToken)
        throw new Error("FORBIDDEN");
    if (!isSettled(run.status))
        throw new Error("INVALID_DELIVERY");
    if (run.deliveryStatus !== "pending")
        return null;
    const root = await ctx.db.get("assignments", run.rootAssignmentId);
    const parent = await ctx.db.get("assignments", run.actorAssignmentId);
    if (args.deliveryStatus === "accepted")
        assertDeliverable(run, root, parent, args);
    const at = Date.now();
    await ctx.db.patch("subagentRuns", run._id, {
        deliveryStatus: args.deliveryStatus,
        errorCode: args.errorCode ?? run.errorCode,
        ...(args.parentMessageId ? { resultMessageId: args.parentMessageId } : {}),
        events: appendEvent(run.events, deliveryPhase[args.deliveryStatus], at, args.errorCode),
    });
    const budget = await spendDeliveryHop(ctx, run, args);
    if (!parent ||
        !root ||
        root.cancelled ||
        parent.cancelled ||
        root.cancellationEpoch !== run.rootCancellationEpoch)
        return null;
    if (args.deliveryStatus === "accepted" &&
        (!budget || budget.cancelled || budget.hops >= root.limits.runHops))
        throw new Error("RUN_BUDGET");
    if (args.deliveryStatus === "accepted" && args.parentMessageId)
        await enqueueResult(ctx, run, parent, args.parentMessageId);
    else
        await wake(ctx, parent);
    await closeRootRun(ctx, root, run.parentRunId);
    return null;
}
/** An accepted delivery needs a live root/parent in the run's epoch and, for
 * accepted deliveries, the saved parent message id. Throwing rolls back the
 * coordinator's native save in the same transaction. */
function assertDeliverable(run, root, parent, args) {
    if (!args.parentMessageId || !root || !parent)
        throw new Error("INVALID_DELIVERY");
    if (root.cancelled ||
        parent.cancelled ||
        parent.turnStatus === "recovery_required" ||
        root.cancellationEpoch !== run.rootCancellationEpoch ||
        root.turnStatus === "recovery_required")
        throw new Error("ROOT_UNAVAILABLE");
}
/** Spend one hop for an accepted delivery (other outcomes rewrite the same
 * count). Returns the budget as read BEFORE the patch: the caller's hop limit
 * check compares that pre-delivery count. */
async function spendDeliveryHop(ctx, run, args) {
    const budget = await ctx.db.get("runs", run.parentRunId);
    if (budget)
        await ctx.db.patch("runs", budget._id, {
            hops: args.deliveryStatus === "accepted" ? budget.hops + 1 : budget.hops,
        });
    return budget;
}
/** An accepted result becomes one ready "result" row on the parent,
 * regardless of the message queue limit: a launch already owes its result. */
async function enqueueResult(ctx, run, parent, parentMessageId) {
    await ctx.db.insert("inbox", {
        assignmentId: parent._id,
        messageId: parentMessageId,
        sequence: parent.nextSequence,
        kind: "result",
        runId: run.parentRunId,
    });
    const backlogged = {
        ...parent,
        queuedMessages: parent.queuedMessages + 1,
        nextSequence: parent.nextSequence + 1,
    };
    await ctx.db.patch("assignments", parent._id, {
        queuedMessages: backlogged.queuedMessages,
        nextSequence: backlogged.nextSequence,
    });
    await wake(ctx, backlogged);
}
/** The host coordinator's notify entry point, typed from its opaque handle. */
function notifyReference(handle) {
    return handle;
}
/** The coordinator's view of a terminal run it was notified about. The
 * delivery token proves the caller holds this run's delivery capability. */
export const deliveryContext = query({
    args: { runId: v.string(), deliveryToken: v.string() },
    returns: v.union(v.null(), v.object(deliveryContextFields)),
    handler: async (ctx, args) => {
        const run = await runById(ctx, args.runId);
        if (!run || run.deliveryToken !== args.deliveryToken)
            return null;
        return terminalContext(ctx, run);
    },
});
/** Ask the host coordinator to deliver a terminal run. If that call fails,
 * record a failed delivery instead (`DELIVERY_UNKNOWN` if that record fails
 * too, see `recordFailure`); the delivery is never retried automatically. */
export const notify = internalAction({
    args: { runId: v.string(), deliveryToken: v.string(), coordinateHandle: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        try {
            await ctx.runMutation(notifyReference(args.coordinateHandle), {
                op: "notify",
                runId: args.runId,
                deliveryToken: args.deliveryToken,
            });
        }
        catch {
            await recordFailure(ctx, args);
        }
        return null;
    },
});
/** Record a failed notify, falling back to `DELIVERY_UNKNOWN`.
 *
 * Why the extra write: a settled run whose delivery stays `pending` holds one
 * cross-request result slot (`canOweResult` in headroom.ts) and a hop, and
 * only a cancel (an epoch bump; the guard counts current-epoch rows only)
 * would ever free it. Reaching the second catch means the notify attempt and
 * the `DELIVERY_FAILED` record have both thrown, so no delivery is in flight
 * any more: recording `failed` with `DELIVERY_UNKNOWN` now (same token, same
 * pending compare-and-set in `applyDelivery`) cannot drop a result that would
 * otherwise arrive. That is "outcome unknown", not "known failure", which is
 * why it has its own code. The delivery itself is never retried.
 *
 * This is best effort: if the unknown record throws too, the error is
 * swallowed and the run stays `pending` until a cancel frees the slot. */
async function recordFailure(ctx, args) {
    const { runId, deliveryToken } = args;
    try {
        await ctx.runMutation(internal.subagents.deliver.failDelivery, { runId, deliveryToken });
    }
    catch {
        try {
            await ctx.runMutation(internal.subagents.deliver.failDelivery, {
                runId,
                deliveryToken,
                unknown: true,
            });
        }
        catch {
            // All three writes failed to commit; nothing is claimed about a
            // delivery that did not happen. Only a cancel clears this row.
        }
    }
}
/** The coordinator's delivery outcome; see `applyDelivery`. */
export const deliver = mutation({
    args: {
        runId: v.string(),
        deliveryToken: v.string(),
        deliveryStatus: v.union(v.literal("accepted"), v.literal("failed"), v.literal("blocked")),
        parentMessageId: v.union(v.string(), v.null()),
        errorCode: runErrorCode,
    },
    returns: v.null(),
    handler: (ctx, args) => applyDelivery(ctx, args),
});
/** notify's fallback when the coordinator itself failed. `unknown` records
 * `DELIVERY_UNKNOWN` instead, for the case where this record also threw. */
export const failDelivery = internalMutation({
    args: { runId: v.string(), deliveryToken: v.string(), unknown: v.optional(v.boolean()) },
    returns: v.null(),
    handler: (ctx, { unknown, ...args }) => applyDelivery(ctx, {
        ...args,
        deliveryStatus: "failed",
        parentMessageId: null,
        errorCode: unknown ? "DELIVERY_UNKNOWN" : "DELIVERY_FAILED",
    }),
});
