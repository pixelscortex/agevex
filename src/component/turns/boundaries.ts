/** Slice boundaries preserve replay refusal and release only the in-flight bit.
 * Workpool owns crashed-step detection; no scheduled alarm belongs to a slice.
 */
import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { resolveRunSettings } from "../run_settings.js";
import { finishTurn } from "./finish.js";
import { wake } from "./wake.js";

/** Close a slice without forgetting the id whose paid work must not replay. */
export async function disarmSlice(ctx: MutationCtx, row: Doc<"assignments">) {
  await ctx.db.patch("assignments", row._id, {
    lastSlice: row.lastSlice ? { ...row.lastSlice, active: false } : undefined,
    activeTools: undefined,
  });
}

/** The host action finished one slice and will run another: close the slice
 * (the turn stays running). */
export async function closeSlice(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<"assignments">;
    executionId: string;
    cancellationEpoch: number;
  },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (
    !row ||
    row.cancelled ||
    row.turnToken !== args.executionId ||
    row.cancellationEpoch !== args.cancellationEpoch ||
    row.turnStatus !== "running"
  )
    return null;

  // A closed slice retains its id but releases next-slice admission.
  await disarmSlice(ctx, row);

  // A running slice cannot be claimed by wake; its next slice still owns it.
  await wake(ctx, {
    ...row,
    lastSlice: row.lastSlice ? { ...row.lastSlice, active: false } : undefined,
  });

  return null;
}

/** Phase 1c's seam: all between-slice state checks belong here. Returns the
 * token to run another slice, or null to end the turn workflow (stale,
 * cancelled, a slice that never reached continueTurn, or a cancelled run). */
export async function admitNextSlice(
  ctx: MutationCtx,
  args: { assignmentId: Id<"assignments">; executionId: string },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (
    !row ||
    row.cancelled ||
    row.turnToken !== args.executionId ||
    row.turnStatus !== "running" ||
    // Only continueTurn releases the active slice.
    row.lastSlice?.active
  )
    return null;

  await disarmSlice(ctx, row);
  const run = row.runId ? await ctx.db.get("runs", row.runId) : null;

  if (!run || run.cancelled) return null;

  const settings =
    run.settings?.find((entry) => entry.agent === row.agent)?.settings ?? resolveRunSettings();

  if ((row.modelSteps ?? 0) >= settings.stepsPerTurn) {
    await finishTurn(ctx, {
      assignmentId: row._id,
      turnToken: args.executionId,
      errorCode: "SLICE_LIMIT",
    });

    return null;
  }

  // Exhausting delegation budget never prevents a final answer. Admission of
  // additional effects checks launches/hops transactionally in reserve.
  if (run.launches > row.limits.runLaunches || run.hops > row.limits.runHops)
    throw new Error("RUN_BUDGET");

  return args.executionId;
}
