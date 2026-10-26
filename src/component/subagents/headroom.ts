/** Shared admission reservations: optional work cannot spend a final result's hop. */
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";

type Spend = "note" | "ask" | "message" | "answer" | "launch";

/** H + 1 + pending results + open answers + reservation delta <= runHops.
 * A launch adds its own future result; an ask adds its eventual answer;
 * an answer consumes an existing reservation. Settlement releases activeRuns
 * before delivery, so only deliveryStatus can identify every owed result.
 * Side results are free, but side questions still need their answer hop.
 * Every count is scoped to this budget and the current cancellation epoch.
 * Note queue reservations include older budgets on the same target. One slot per
 * result is conservative for joins; queueLength rows suffice to refuse.
 * <=58 budget rows +100 target rows, each <=4 KiB =632 KiB /158 reads.
 * Five note admission passes add <=3,160 KiB /790 reads; the native-save
 * transaction remains <10 MiB /1,500 reads. Ask/message use two passes and
 * launch one, leaving their native saves + wake below those same ceilings.
 */
export async function reserveFor(
  ctx: QueryCtx | MutationCtx,
  kind: Spend,
  root: Doc<"assignments">,
  budget: Doc<"runs">,
  target?: Doc<"assignments">,
) {
  const runs = await ctx.db
    .query("subagentRuns")
    .withIndex("by_group", (q) => q.eq("parentRunId", budget._id))
    .take(root.limits.runLaunches + root.limits.sideRunsPerRun);

  const current = runs.filter((run) => run.rootCancellationEpoch === root.cancellationEpoch);
  const pending = current.filter((run) => !run.side && run.deliveryStatus === "pending").length;
  const answers = current.filter((run) => run.status === "asking").length;
  const delta = Number(kind === "launch" || kind === "ask") - Number(kind === "answer");

  if (target && kind === "note") {
    const deliveries = await ctx.db
      .query("subagentRuns")
      .withIndex("by_parent_delivery", (q) =>
        q.eq("actorAssignmentId", target._id).eq("side", undefined).eq("deliveryStatus", "pending"),
      )
      .take(root.limits.queueLength);

    if (target.queuedMessages + 1 + deliveries.length > root.limits.queueLength)
      return { kind: "denied" as const, code: "QUEUE_LIMIT" as const };
  }

  if (budget.hops + 1 + pending + answers + delta > root.limits.runHops)
    return { kind: "denied" as const, code: "RUN_BUDGET" as const };

  return null;
}

/** Approval pauses own one existing control slot outside the ordinary queue.
 * Only the exact, still-ready continuation earns this allowance: approvals
 * can remain recorded after claim deleted that row. No transcript scan or
 * capacity increase for ordinary sends is needed. One <=1 KiB point read.
 */
export async function deliveryQueueLimit(ctx: QueryCtx | MutationCtx, parent: Doc<"assignments">) {
  const continuation = parent.approvals
    ? await ctx.db.get("inbox", parent.approvals.inboxId)
    : null;

  return parent.limits.queueLength + Number(!!continuation && continuation.passive === undefined);
}
