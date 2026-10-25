/**
 * Delivering a terminal child's result to its parent thread.
 *
 * The host coordinator saves the result natively in the parent thread and
 * then calls `subagents.deliver` (or `notify` records `failDelivery`). One
 * delivery per run: it records the outcome on the run, spends one hop of the
 * shared budget for accepted ordinary results, and either enqueues the result
 * as ready parent work, marks its wait-"all" cohort ready, or just wakes the
 * parent so R3 can re-check. Touches `subagentRuns`, `runs`, `inbox` and the
 * parent's counters.
 */
import type { MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { groupMembers, isSettled, runById, appendEvent } from "./runs.js";
import { wake } from "../queue/wake.js";
import { markGroupReady } from "./groups.js";

type Delivery = {
  runId: string;
  deliveryToken: string;
  deliveryStatus: "accepted" | "failed" | "blocked";
  parentMessageId: string | null;
  errorCode: Doc<"subagentRuns">["errorCode"];
};

/** The event phase recorded for each delivery outcome. */
const deliveryPhase = {
  accepted: "result_accepted",
  failed: "delivery_failed",
  blocked: "delivery_blocked",
} as const;

/** Each terminal delivery spends one hop and appends ready work immediately.
 * The delivery token is the capability; a repeated delivery is a no-op. */
export async function applyDelivery(ctx: MutationCtx, args: Delivery) {
  const run = await runById(ctx, args.runId);
  if (!run || run.deliveryToken !== args.deliveryToken) throw new Error("FORBIDDEN");
  if (!isSettled(run.status)) throw new Error("INVALID_DELIVERY");
  if (run.deliveryStatus !== "pending") return null;

  const root = await ctx.db.get("assignments", run.rootAssignmentId);
  const parent = await ctx.db.get("assignments", run.actorAssignmentId);
  if (args.deliveryStatus === "accepted") assertDeliverable(run, root, parent, args);

  const at = Date.now();
  await ctx.db.patch("subagentRuns", run._id, {
    deliveryStatus: args.deliveryStatus,
    deliveryAt: at,
    errorCode: args.errorCode ?? run.errorCode,
    ...(args.parentMessageId ? { resultMessageId: args.parentMessageId } : {}),
    // Only releaseGroup orders a joined cohort by it; "each" rows never need it.
    ...(args.parentMessageId && run.join ? { resultSequence: parent?.nextSequence } : {}),
    events: appendEvent(run.events, deliveryPhase[args.deliveryStatus], at, args.errorCode),
  });
  if (run.side) return null;

  const budget = await spendDeliveryHop(ctx, run, args);
  if (
    !parent ||
    !root ||
    root.cancelled ||
    parent.cancelled ||
    root.cancellationEpoch !== run.rootCancellationEpoch
  )
    return null;
  if (
    args.deliveryStatus === "accepted" &&
    (!budget || budget.cancelled || budget.hops >= root.limits.runHops)
  )
    throw new Error("RUN_BUDGET");

  if (run.join) await deliverJoinMember(ctx, run, parent, root, args);
  else if (args.deliveryStatus === "accepted" && args.parentMessageId)
    await enqueueResult(ctx, run, parent, root, args.parentMessageId);
  else await wake(ctx, parent);
  return null;
}

/** An accepted delivery needs a live root/parent in the run's epoch and, for
 * ordinary runs, the saved parent message id. Throwing rolls back the
 * coordinator's native save in the same transaction. */
function assertDeliverable(
  run: Doc<"subagentRuns">,
  root: Doc<"assignments"> | null,
  parent: Doc<"assignments"> | null,
  args: Delivery,
) {
  if ((!args.parentMessageId && !run.side) || !root || !parent) throw new Error("INVALID_DELIVERY");
  if (
    root.cancelled ||
    parent.cancelled ||
    parent.turnStatus === "recovery_required" ||
    root.cancellationEpoch !== run.rootCancellationEpoch ||
    root.turnStatus === "recovery_required"
  )
    throw new Error("ROOT_UNAVAILABLE");
}

/** Spend one hop for an accepted delivery (other outcomes rewrite the same
 * count). Returns the budget as read BEFORE the patch: the caller's hop limit
 * check compares that pre-delivery count. */
async function spendDeliveryHop(ctx: MutationCtx, run: Doc<"subagentRuns">, args: Delivery) {
  const budget = await ctx.db.get("runs", run.parentRunId);
  if (budget)
    await ctx.db.patch("runs", budget._id, {
      hops: args.deliveryStatus === "accepted" ? budget.hops + 1 : budget.hops,
    });
  return budget;
}

/** A wait-"all" member: allocate its result order on the parent, mark the
 * cohort ready if this was its last pending member, and wake the parent. */
async function deliverJoinMember(
  ctx: MutationCtx,
  run: Doc<"subagentRuns">,
  parent: Doc<"assignments">,
  root: Doc<"assignments">,
  args: Delivery,
) {
  // <=15 members *4 KiB =60 KiB. Mark readiness and enqueue ONE id-only
  // anchor; <=15 release markers. No historical candidate prefix is read.
  // Native child bodies are verified ONE per delivery transaction (<=1 MiB);
  // this join reads ids only, never 15 potentially 1 MiB native results.
  const members = await groupMembers(
    ctx,
    { parentRunId: run.parentRunId, actorAssignmentId: parent._id, group: run.group ?? "" },
    root.limits.activeChildrenPerRoot,
  );
  if (args.deliveryStatus === "accepted") {
    await ctx.db.patch("assignments", parent._id, { nextSequence: parent.nextSequence + 1 });
    parent.nextSequence++;
  }

  await markGroupReady(ctx, members, root);
  await wake(ctx, (await ctx.db.get("assignments", parent._id))!);
}

/** An ordinary accepted result becomes one ready "result" row on the parent,
 * refused when the parent's ready queue is full. */
async function enqueueResult(
  ctx: MutationCtx,
  run: Doc<"subagentRuns">,
  parent: Doc<"assignments">,
  root: Doc<"assignments">,
  parentMessageId: string,
) {
  if (parent.queuedMessages >= root.limits.queueLength) throw new Error("QUEUE_LIMIT");

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
