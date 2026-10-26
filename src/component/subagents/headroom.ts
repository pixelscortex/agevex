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
 * Side results are free, but side questions still need their answer hop.
 * Every count is scoped to this budget and the current cancellation epoch.
 * <=58 budget rows *4 KiB =232 KiB /58 reads per pass. Five note
 * admission passes add <=1,160 KiB /290 reads; the native-save transaction
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
    .withIndex("by_group", (q) => q.eq("parentRunId", budget._id))
    .take(root.limits.runLaunches + root.limits.sideRunsPerRun);

  const current = runs.filter((run) => run.rootCancellationEpoch === root.cancellationEpoch);
  const pending = current.filter((run) => !run.side && run.deliveryStatus === "pending").length;
  const answers = current.filter((run) => run.status === "asking").length;
  const delta = Number(kind === "launch" || kind === "ask") - Number(kind === "answer");

  if (budget.hops + 1 + pending + answers + delta > root.limits.runHops)
    return { kind: "denied" as const, code: "RUN_BUDGET" as const };

  return null;
}

/** Bound outstanding result work on ONE assignment, across user budgets.
 * runLaunches alone only bounds a single request: a root can process another
 * user prompt while old children or sealed joins still owe results. Admission
 * counts pending ordinary deliveries, unreleased join members and ready result
 * rows. Delivery replaces a pending member with a row; a joined row replaces
 * its members; claim removes work. Only launch can increase this total.
 * No queue slots are reserved and queueLength never gates a launch or result.
 * Four <=50 metadata ranges *4 KiB +152 ready ids *1 KiB <1 MiB;
 * the entire launch/native task-save transaction stays <4 MiB /512 reads.
 * Current-epoch index ranges exclude cancelled history without a prefix scan.
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
        .eq("side", undefined)
        .eq("deliveryStatus", "pending")
        .eq("rootCancellationEpoch", root.cancellationEpoch),
    )
    .take(cap);

  const owed = new Set(pending.map((run) => run._id));

  for (const join of ["open", "sealed", "ready"] as const) {
    const members = await ctx.db
      .query("subagentRuns")
      .withIndex("by_join", (q) =>
        q
          .eq("actorAssignmentId", actor._id)
          .eq("rootCancellationEpoch", root.cancellationEpoch)
          .eq("join", join),
      )
      .take(cap);

    for (const member of members) owed.add(member._id);
  }

  const ready = await readyRows(ctx, actor._id, readyRowLimit(actor.limits));

  return owed.size + ready.filter((row) => row.kind === "result").length < cap;
}
