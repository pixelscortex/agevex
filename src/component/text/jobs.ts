/** Queue one non-retried child-lane job per kind/thread. No model work occurs
 * in foreground mutations; only bounded metadata and dispatch refs are written. */
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { laneManager } from "../workflows/lanes.js";

/** A capability is minted once; repeat deliveries can never reclaim a paid job. */
export function newTextJob(row: Doc<"assignments">, runId: Id<"runs">, kind: "title" | "summary") {
  const first = row.contextMessages?.[0];

  const titleRef = first
    ? { id: first.id, order: first.order, stepOrder: first.stepOrder, bytes: first.bytes }
    : undefined;

  return {
    key: crypto.randomUUID(),
    runId,
    epoch: row.cancellationEpoch,
    version: row.titleVersion ?? 0,
    status: "queued" as const,
    ...(kind === "title" ? { titleRef } : {}),
  };
}

/** Coalesce only live work. Unknown paid outcomes need a fresh explicit key;
 * a known failure permits the next cadence point to schedule new work. */
export async function queueText(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  kind: "title" | "summary",
  runId: Id<"runs">,
  explicit = false,
) {
  const config = row.textConfig;

  if (!config?.[kind] || row.cancelled || row.childRunId) return;

  const field = kind === "title" ? "titleTask" : "summaryTask";
  const previous = row[field];

  if (kind === "title" && (previous || row.titleSource === "user")) return;

  if (previous?.status === "unknown" && !explicit) return;

  if (previous?.status === "queued" && previous.epoch === row.cancellationEpoch) return;

  if (previous?.status === "running" && previous.epoch === row.cancellationEpoch) {
    await ctx.db.patch("assignments", row._id, { [field]: { ...previous, again: runId } });

    return;
  }

  const job = {
    ...newTextJob(row, runId, kind),
    deferred: kind === "summary" && !row.textCompleted,
  };

  await ctx.db.patch("assignments", row._id, { [field]: job });

  if (job.deferred) return;

  await dispatchText(ctx, row, kind, job);
}

/** An early on-demand request waits for the first completed root boundary,
 * without occupying a worker or polling while foreground work is running. */
async function dispatchText(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  kind: "title" | "summary",
  job: NonNullable<Doc<"assignments">["summaryTask"]>,
) {
  const config = row.textConfig!;
  const field = kind === "title" ? "titleTask" : "summaryTask";

  await ctx.db.patch("assignments", row._id, { [field]: { ...job, deferred: undefined } });

  try {
    await laneManager(true, row.limits).start(
      ctx,
      internal.text.worker.work,
      {
        assignmentId: row._id,
        kind,
        key: job.key,
        handle: config.worker,
      },
      {
        startAsync: true,
        context: { assignmentId: row._id, kind, key: job.key },
        onComplete: internal.text.worker.done,
      },
    );
  } catch {
    // Background dispatch failure records a known failure; acceptance and
    // foreground completion still commit. Never retry the paid path here.
    await ctx.db.patch("assignments", row._id, { [field]: { ...job, status: "failed" } });
  }
}

/** Cadence counts completed root turns, never tool slices or child turns.
 * Exact saved identity supplies the boundary without any transcript discovery. */
export async function completeTextTurn(ctx: MutationCtx, row: Doc<"assignments">) {
  if (!row.textConfig?.summary || row.childRunId) return;

  const last = row.contextMessages?.find((ref) => ref.id === row.modelStep?.messageId);

  if (!last) return;

  const textCompleted = {
    id: last.id,
    order: last.order,
    stepOrder: last.stepOrder,
    sequence: last.sequence,
  };

  await ctx.db.patch("assignments", row._id, { textCompleted });

  if (
    row.summaryTask?.status === "queued" &&
    row.summaryTask.deferred &&
    row.summaryTask.epoch === row.cancellationEpoch
  ) {
    await dispatchText(ctx, { ...row, textCompleted }, "summary", row.summaryTask);

    return;
  }

  const every = row.textConfig.everyTurns;

  if (every && row.completedTurns % every === 0 && row.runId)
    await queueText(ctx, { ...row, textCompleted }, "summary", row.runId);
}
