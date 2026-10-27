/** Seed terminal history only; the cancellation test retains one native delivery.
 * At most 49 small rows plus ready references are written per transaction.
 * No terminal child assignment or native transcript is needed by cancellation. */
import { v } from "convex/values";
import { mutation, query } from "../src/component/_generated/server.js";
import { newSubagentRun, runById } from "../src/component/subagents/runs.js";

export const seed = mutation({
  args: { assignmentId: v.id("assignments"), count: v.number() },
  returns: v.null(),
  handler: async (ctx, { assignmentId, count }) => {
    const actor = (await ctx.db.get("assignments", assignmentId))!;
    const root = (await ctx.db.get("assignments", actor.rootAssignmentId!))!;
    const budget = (await ctx.db.get("runs", actor.runId!))!;

    for (let i = 0; i < count; i++) {
      const key = `${assignmentId}:history:${i}`;
      const messageId = `historical-result-${i}`;
      const now = Date.now();

      await ctx.db.insert("subagentRuns", {
        ...newSubagentRun({
          request: { agent: "Reviewer", payloadFingerprint: "hash", coordinateHandle: "opaque" },
          actor,
          root,
          budget,
          depth: 2,
          dedupKey: key,
          sequence: root.nextRunSequence + i + 1,
          now,
        }),
        status: "failed",
        errorCode: "GENERATION_FAILED",
        deliveryStatus: "accepted",
        resultMessageId: messageId,
        events: [
          { phase: "failed", at: now, errorCode: "GENERATION_FAILED" },
          { phase: "result_accepted", at: now, errorCode: null },
        ],
      });

      await ctx.db.insert("inbox", {
        assignmentId,
        runId: budget._id,
        kind: "result",
        messageId,
        sequence: actor.nextSequence + i,
      });
    }

    await ctx.db.patch("runs", budget._id, {
      launches: budget.launches + count,
      hops: budget.hops + 2 * count,
    });

    await ctx.db.patch("assignments", root._id, { nextRunSequence: root.nextRunSequence + count });

    await ctx.db.patch("assignments", assignmentId, {
      queuedMessages: actor.queuedMessages + count,
      nextSequence: actor.nextSequence + count,
    });

    return null;
  },
});

/** Verify public delegation identity against the persisted row, without an index. */
export const identity = query({
  args: { runId: v.string() },
  returns: v.union(v.null(), v.id("subagentRuns")),
  handler: async (ctx, { runId }) => (await runById(ctx, runId))?._id ?? null,
});
