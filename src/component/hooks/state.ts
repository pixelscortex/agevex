/**
 * Per-turn hook bookkeeping of a running turn.
 *
 * `hookState` (`recordHookState`) stores a beforeTurn model choice on the run
 * and counts completed turns (the hooks' `turn` number and side review
 * cadence). `continueAdmission` (`stageContinuation`) stages an afterTurn
 * continuation prompt as a non-ready inbox row that only the turn's next
 * slice claim consumes, spending one of the run's `continuesPerRun`. Both are
 * fenced to the turn's execution token. Touches `assignments`, `runs` and
 * `inbox`.
 */
import { type MutationCtx, mutation } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";
import { newRun } from "../turns/runs.js";
import { validModelOverrides } from "../models.js";
import { v } from "convex/values";

/** Record a beforeTurn model choice (validated against the override bounds)
 * and/or count a completed turn. Returns the completed-turn count after this
 * call; throws STALE_TURN for a turn that lost its token. */
export async function recordHookState(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<"assignments">;
    executionId: string;
    model?: string;
    complete?: boolean;
  },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (!row || row.cancelled || row.turnToken !== args.executionId || row.turnStatus !== "running")
    throw new Error("STALE_TURN");

  if (args.model && row.runId) {
    const run = await ctx.db.get("runs", row.runId);
    const models = { ...run?.models, [row.agent]: args.model };

    if (!run || !validModelOverrides(models)) throw new Error("INVALID_MODELS");

    // A routing choice can enlarge the model map after acceptance. Reuse the
    // row builder's envelope check before changing this run's bounded metadata.
    newRun(models, run.settings, {
      rootAssignmentId: run.rootAssignmentId,
      rootCancellationEpoch: run.rootCancellationEpoch,
      taskMessageId: run.taskMessageId,
      taskPreview: run.taskPreview,
    });

    await ctx.db.patch("runs", run._id, { models });
  }

  if (args.complete)
    await ctx.db.patch("assignments", row._id, { completedTurns: row.completedTurns + 1 });

  return row.completedTurns + (args.complete ? 1 : 0);
}

/** Stage an afterTurn continuation prompt for this turn's next slice. Returns
 * the staged inbox row id, or null (no continuation) for a stale turn, a
 * cancelled run or an exhausted allowance. */
export async function stageContinuation(
  ctx: MutationCtx,
  args: { assignmentId: Id<"assignments">; executionId: string; prompt: string },
) {
  if (!args.prompt.trim() || args.prompt.length > LIMITS.messageLength)
    throw new Error("INVALID_CONTINUE");

  const row = await ctx.db.get("assignments", args.assignmentId);
  const run = row?.runId ? await ctx.db.get("runs", row.runId) : null;

  if (
    !row ||
    row.cancelled ||
    row.turnToken !== args.executionId ||
    row.turnStatus !== "running" ||
    !run ||
    run.cancelled ||
    run.continues >= row.limits.continuesPerRun
  )
    return null;

  // Stage the hook prompt until its claim so pending notes can be placed
  // after the completed response and BEFORE this continuation in one batch.
  // <=16,000 UTF-16 units (64 KiB) plus metadata, well below 1 MiB.
  const messageId = await ctx.db.insert("inbox", {
    assignmentId: row._id,
    messageId: "",
    text: args.prompt,
    sequence: row.nextSequence,
    runId: run._id,
    kind: "continue",
    passive: false,
  });

  await ctx.db.patch("runs", run._id, { continues: run.continues + 1 });

  await ctx.db.patch("assignments", row._id, {
    hookContinue: true,
    nextSequence: row.nextSequence + 1,
    inboxId: messageId,
  });

  return messageId;
}

/** Record a beforeTurn model choice and/or a completed turn. */
export const hookState = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    model: v.optional(v.string()),
    complete: v.optional(v.boolean()),
  },
  handler: (ctx, args) => recordHookState(ctx, args),
});

/** Stage an afterTurn hook's continuation prompt for the next slice. */
export const continueAdmission = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    prompt: v.string(),
  },
  handler: (ctx, args) => stageContinuation(ctx, args),
});
