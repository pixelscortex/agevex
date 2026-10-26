/** Shared admission reservations: optional work cannot spend an owed result or answer hop. */
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { readyRows } from "../turns/inbox.js";
import { readyRowLimit } from "../limits.js";

type Spend = "note" | "ask" | "message" | "answer" | "launch";

/** H + 1 + pending results + open answers + reservation delta <= runHops.
 * A launch adds its own future result; an ask adds its eventual answer;
 * an answer consumes an existing reservation. Settlement releases activeRuns
 * before delivery, so only deliveryStatus can identify every owed result.
 * Every count is scoped to this budget and the current cancellation epoch.
 * <=50 budget rows *4 KiB =200 KiB /50 reads per pass. Five note
 * admission passes add <=1,000 KiB /250 reads; the native-save transaction
 * remains <8 MiB /1,000 reads. Queue admission needs only the target counter.
 */
export async function reserveFor(
  ctx: QueryCtx | MutationCtx,
  kind: Spend,
  root: Doc<"assignments">,
  budget: Doc<"runs">,
) {
  const runs = await ctx.db
    .query("subagentRuns")
    .withIndex("by_parent_run", (q) => q.eq("parentRunId", budget._id))
    .take(root.limits.runLaunches);

  const current = runs.filter((run) => run.rootCancellationEpoch === root.cancellationEpoch);
  const pending = current.filter((run) => run.deliveryStatus === "pending").length;
  const answers = current.filter((run) => run.status === "asking").length;
  const delta = Number(kind === "launch" || kind === "ask") - Number(kind === "answer");

  if (budget.hops + 1 + pending + answers + delta > root.limits.runHops)
    return { kind: "denied" as const, code: "RUN_BUDGET" as const };

  return null;
}

/** Bound outstanding result work on one assignment across user budgets.
 * Delivery replaces a pending child with a ready result; claim removes it.
 * Only launch can increase the total. The <=50 child rows *4 KiB plus
 * <=152 ready ids *1 KiB remain <352 KiB. Current-epoch index ranges
 * exclude cancelled history without reading a historical prefix.
 */
export async function canOweResult(
  ctx: MutationCtx,
  actor: Doc<"assignments">,
  root: Doc<"assignments">,
) {
  const cap = actor.limits.runLaunches;

  const pending = await ctx.db
    .query("subagentRuns")
    .withIndex("by_parent_delivery", (q) =>
      q
        .eq("actorAssignmentId", actor._id)
        .eq("deliveryStatus", "pending")
        .eq("rootCancellationEpoch", root.cancellationEpoch),
    )
    .take(cap);

  const ready = await readyRows(ctx, actor._id, readyRowLimit(actor.limits));

  return pending.length + ready.filter((row) => row.kind === "result").length < cap;
}
