/** Shared admission reservations: optional work cannot take an owed result's capacity. */
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";

type Spend = "note" | "ask" | "message" | "answer" | "launch";

/** H + 1 + pending results + open answers + reservation delta <= runHops.
 * A launch adds its own future result; an ask adds its eventual answer;
 * an answer consumes an existing reservation. Settlement releases activeRuns
 * before delivery, so only deliveryStatus can identify every owed result.
 * Side results are free, but side questions still need their answer hop.
 * Every count is scoped to this budget and the current cancellation epoch.
 * Queue reservations include older budgets on the same target. One slot per
 * result is conservative for joins; queueLength rows suffice to refuse,
 * plus one sentinel when an ask excludes its own pending result.
 * <=58 budget rows +101 target rows, each <=4 KiB =636 KiB /159 reads.
 * Five note admission passes add <=3,180 KiB /795 reads; the native-save
 * transaction remains <10 MiB /1,500 reads. Ask/message use two passes and
 * launch one, leaving their native saves + wake below those same ceilings.
 */
export async function reserveFor(
  ctx: QueryCtx | MutationCtx,
  kind: Spend,
  root: Doc<"assignments">,
  budget: Doc<"runs">,
  target?: Doc<"assignments">,
  askingRun?: Id<"subagentRuns">,
) {
  const runs = await ctx.db
    .query("subagentRuns")
    .withIndex("by_group", (q) => q.eq("parentRunId", budget._id))
    .take(root.limits.runLaunches + root.limits.sideRunsPerRun);

  const current = runs.filter((run) => run.rootCancellationEpoch === root.cancellationEpoch);
  const pending = current.filter((run) => !run.side && run.deliveryStatus === "pending").length;
  const answers = current.filter((run) => run.status === "asking").length;
  const delta = Number(kind === "launch" || kind === "ask") - Number(kind === "answer");

  if (
    target &&
    kind !== "answer" &&
    kind !== "launch" &&
    !(await queueHasRoom(ctx, target, kind === "ask" ? askingRun : undefined))
  )
    return { kind: "denied" as const, code: "QUEUE_LIMIT" as const };

  if (budget.hops + 1 + pending + answers + delta > root.limits.runHops)
    return { kind: "denied" as const, code: "RUN_BUDGET" as const };

  return null;
}

/** Every non-delivery enqueue leaves one slot per owed ordinary result, across
 * all user budgets on this queue. An ask may reuse its own result reservation:
 * its question must be consumed before its result can exist. Read one extra
 * row when excluding it, so truncation cannot hide another pending delivery.
 * <=101 metadata rows *4 KiB =404 KiB per pass; user sends use two passes
 * (preflight + accept), adding <=808 KiB /202 reads to their native save.
 * Answers bypass this check and use their existing reserved control slot.
 */
export async function queueHasRoom(
  ctx: QueryCtx | MutationCtx,
  target: Doc<"assignments">,
  askingRun?: Id<"subagentRuns">,
) {
  const deliveries = await ctx.db
    .query("subagentRuns")
    .withIndex("by_parent_delivery", (q) =>
      q.eq("actorAssignmentId", target._id).eq("side", undefined).eq("deliveryStatus", "pending"),
    )
    .take(target.limits.queueLength + Number(!!askingRun));

  const pending = deliveries.filter((run) => run._id !== askingRun).length;

  return target.queuedMessages + 1 + pending <= target.limits.queueLength;
}

/** Approval pauses own one existing control slot outside the ordinary queue.
 * Only the exact, still-counted continuation earns this allowance: reserveHead
 * subtracts it before claim deletes it, while approvals can outlive both.
 * Counting it again during that window would exceed queueLength +1. No
 * transcript scan or capacity increase for ordinary sends is needed.
 * One <=1 KiB point read.
 */
export async function deliveryQueueLimit(ctx: QueryCtx | MutationCtx, parent: Doc<"assignments">) {
  const continuation = parent.approvals
    ? await ctx.db.get("inbox", parent.approvals.inboxId)
    : null;

  return (
    parent.limits.queueLength +
    Number(
      !!continuation && continuation.passive === undefined && parent.inboxId !== continuation._id,
    )
  );
}
