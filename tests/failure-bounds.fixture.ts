/** The failure transaction's conservative maximum ready-metadata envelope. */
import { v } from "convex/values";
import { internalMutation } from "../src/component/_generated/server.js";
import { readyRowLimit } from "../src/component/limits.js";
import { RUN_LIMITS } from "../src/component/run_settings.js";
import { fillAssignment, maximumRun, padded } from "./assignment-envelope.fixture.js";

/** Bodies remain native; a failure retires only its own run's ready controls. */
export const seedBacklog = internalMutation({
  args: { assignmentId: v.id("assignments") },
  returns: v.number(),
  handler: async (ctx, { assignmentId }) => {
    const row = (await ctx.db.get("assignments", assignmentId))!;
    const count = readyRowLimit(row.limits);

    for (let i = 0; i < count; i++) {
      const runId =
        i === 0
          ? row.runId!
          : await ctx.db.insert(
              "runs",
              maximumRun({ rootAssignmentId: assignmentId, taskMessageId: row.promptMessageId! }),
            );

      const run = (await ctx.db.get("runs", runId))!;

      await ctx.db.replace(
        "runs",
        runId,
        padded(
          { ...run, finishedAt: Date.now(), errorCode: "EXECUTION_AMBIGUOUS" as const },
          "taskMessageId",
          RUN_LIMITS.metadataBytes,
        ),
      );

      await ctx.db.insert("inbox", {
        assignmentId,
        runId,
        messageId: row.promptMessageId!,
        sequence: row.nextSequence + i,
        kind: "result",
      });
    }

    await ctx.db.patch("assignments", assignmentId, {
      queuedMessages: count,
      nextSequence: row.nextSequence + count,
    });

    await fillAssignment(ctx, assignmentId);

    return count;
  },
});

/** A delivered native result is already durable when its ready control arrives. */
export const seedResult = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    runId: v.optional(v.id("runs")),
    messageId: v.optional(v.string()),
  },
  returns: v.id("inbox"),
  handler: async (ctx, { assignmentId, runId, messageId }) => {
    const row = (await ctx.db.get("assignments", assignmentId))!;

    const id = await ctx.db.insert("inbox", {
      assignmentId,
      runId: runId ?? row.runId!,
      messageId: messageId ?? row.promptMessageId!,
      sequence: row.nextSequence,
      kind: "result",
    });

    await ctx.db.patch("assignments", assignmentId, {
      queuedMessages: row.queuedMessages + 1,
      nextSequence: row.nextSequence + 1,
    });

    return id;
  },
});
