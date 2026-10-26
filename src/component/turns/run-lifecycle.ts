/** Root lifecycle snapshots survive later sends on the same assignment.
 * Closure uses exact request-scoped existence probes, never delegation history.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";

/** One ready row <=1 KiB; passive notes and other user requests are excluded. */
export function readyForRun(ctx: QueryCtx, assignmentId: Id<"assignments">, runId: Id<"runs">) {
  return ctx.db
    .query("inbox")
    .withIndex("by_run_ready", (q) =>
      q.eq("assignmentId", assignmentId).eq("runId", runId).eq("passive", undefined),
    )
    .first();
}

/** Transitive ordinary-delivery and unjoined-group fences, scoped to one request.
 * Four probes <=4*4 KiB, plus <=1 KiB ready work. Side reviews never fence closure.
 */
export async function rootRunBlocked(ctx: QueryCtx, root: Doc<"assignments">, runId: Id<"runs">) {
  if (await readyForRun(ctx, root._id, runId)) return true;

  if (
    await ctx.db
      .query("subagentRuns")
      .withIndex("by_parent_delivery", (q) =>
        q
          .eq("actorAssignmentId", root._id)
          .eq("side", undefined)
          .eq("deliveryStatus", "pending")
          .eq("rootCancellationEpoch", root.cancellationEpoch)
          .eq("parentRunId", runId),
      )
      .first()
  )
    return true;

  for (const join of ["open", "sealed", "ready"] as const)
    if (
      await ctx.db
        .query("subagentRuns")
        .withIndex("by_join", (q) =>
          q
            .eq("actorAssignmentId", root._id)
            .eq("rootCancellationEpoch", root.cancellationEpoch)
            .eq("join", join)
            .eq("parentRunId", runId),
        )
        .first()
    )
      return true;

  return false;
}

/** Called after a root turn or blocker-clearing delivery/group release. Recording
 * closure once makes history independent of later assignment status and clocks.
 * <=16 KiB run +17 KiB probes +16 KiB patch read, <64 KiB per invocation.
 */
export async function closeRootRun(ctx: MutationCtx, root: Doc<"assignments">, runId = root.runId) {
  if (root.childRunId || !runId) return;

  const run = await ctx.db.get("runs", runId);

  if (!run || run.rootAssignmentId !== root._id || run.finishedAt !== undefined) return;

  if (run.turnEndedAt === undefined || run.cancelled || run.errorCode) return;

  if (
    run.rootCancellationEpoch !== undefined &&
    run.rootCancellationEpoch !== root.cancellationEpoch
  )
    return;

  if (root.runId === runId && (root.turnStatus !== "idle" || root.approvalBlocked)) return;

  if (await rootRunBlocked(ctx, root, runId)) return;

  await ctx.db.patch("runs", runId, { finishedAt: Date.now() });
}

/** The root's last turn outcome; only successful, unfenced runs close as done. */
export async function endRootTurn(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  errorCode: Doc<"assignments">["errorCode"],
) {
  if (row.childRunId || !row.runId) return;

  await ctx.db.patch("runs", row.runId, {
    turnEndedAt: Date.now(),
    errorCode,
    ...(errorCode && errorCode !== "BUDGET_EXCEEDED" ? { finishedAt: Date.now() } : {}),
  });
}
