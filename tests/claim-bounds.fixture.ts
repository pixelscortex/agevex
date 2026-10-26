/** A child claims a full previous report, 152 ready rows and maximum notes. */
import { v } from "convex/values";
import { mutation } from "../src/component/_generated/server.js";
import { HOST_LIMITS, LIMITS, resolveLimits } from "../src/component/limits.js";
import { newRootAssignment } from "../src/component/turns/assignments.js";
import { newRun } from "../src/component/turns/runs.js";
import { newSubagentRun } from "../src/component/subagents/runs.js";
import { resolveRunSettings } from "../src/component/run_settings.js";
import { fillAssignment, fillNotes, fullReport } from "./assignment-envelope.fixture.js";

export const seed = mutation({
  args: { threadId: v.string(), promptMessageId: v.string() },
  handler: async (ctx, args) => {
    const limits = resolveLimits(
      Object.fromEntries(Object.entries(HOST_LIMITS).map(([key, bound]) => [key, bound.max])),
    );

    const base = newRootAssignment({
      subject: "alice",
      agent: "Main",
      threadId: "root",
      runTurn: "opaque",
      limits,
    });

    const rootId = await ctx.db.insert("assignments", base);

    const runId = await ctx.db.insert(
      "runs",
      newRun(
        undefined,
        Array.from({ length: LIMITS.agents }, (_, i) => ({
          agent: String(i).padEnd(100, "a"),
          settings: resolveRunSettings(),
        })),
      ),
    );

    await ctx.db.patch("assignments", rootId, { runId });
    const root = (await ctx.db.get("assignments", rootId))!;
    const budget = (await ctx.db.get("runs", runId))!;

    const childId = await ctx.db.insert("assignments", {
      ...base,
      agent: "Builder",
      threadId: args.threadId,
      rootAssignmentId: rootId,
      childRunId: "claim-child",
      runId,
      promptMessageId: args.promptMessageId,
      turnStatus: "queued",
      turnToken: "claim",
      turnOrigin: "subagent_result",
      queuedMessages: limits.queueLength + limits.runLaunches + 1,
    });

    const child = (await ctx.db.get("assignments", childId))!;

    const run = newSubagentRun({
      request: { agent: "Builder", payloadFingerprint: "hash", coordinateHandle: "opaque" },
      runId: "claim-child",
      actor: root,
      root,
      budget,
      depth: 1,
      dedupKey: "child",
      sequence: 0,
      now: Date.now(),
    });

    await ctx.db.insert("subagentRuns", { ...run, childAssignmentId: childId, status: "running" });
    let head;
    let previousResume;

    for (let i = 0; i < limits.queueLength + 2; i++) {
      const id = await ctx.db.insert("inbox", {
        assignmentId: childId,
        runId,
        messageId: args.promptMessageId,
        sequence: i,
        kind: "parent",
        from: "f".repeat(200),
      });

      head ??= id;
      previousResume = id;
    }

    for (let i = 0; i < limits.runLaunches; i++)
      await ctx.db.insert("inbox", {
        assignmentId: childId,
        runId,
        kind: "result",
        messageId: args.promptMessageId,
        sequence: i + limits.queueLength + 2,
      });

    await ctx.db.patch("assignments", childId, {
      inboxId: head,
      turnReport: fullReport(previousResume!),
      nextSequence: limits.queueLength + 2,
    });

    await fillNotes(ctx, child);
    await fillAssignment(ctx, rootId);
    await fillAssignment(ctx, childId);

    return { rootId, childId };
  },
});
