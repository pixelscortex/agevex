// Test-only component fixture: maximum pending fan-out with exact native sources.
import { mutation } from "../src/component/_generated/server.js";
import { v } from "convex/values";
import { newRootAssignment } from "../src/component/turns/assignments.js";
import type { MessageDoc } from "@convex-dev/agent";
import type { FunctionHandle } from "convex/server";
import { collectPause } from "../src/component/turns/pause.js";
import { HOST_LIMITS, LIMITS } from "../src/component/limits.js";

/** Seed coordination only; all proposed tool inputs live in real native documents. */
export const seed = mutation({
  args: {
    root: v.id("assignments"),
    getMessages: v.string(),
    addMessages: v.string(),
    sources: v.array(v.object({ threadId: v.string(), messageIds: v.array(v.string()) })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const root = (await ctx.db.get("assignments", args.root))!;

    for (const [offset, source] of args.sources.entries()) {
      const assignmentId =
        offset === 0
          ? root._id
          : await ctx.db.insert("assignments", {
              ...newRootAssignment({
                subject: root.subject,
                agent: "Helper",
                threadId: source.threadId,
                runTurn: root.runTurn,
                limits: root.limits,
              }),
              rootAssignmentId: root._id,
              runId: root.runId,
            });

      if (offset)
        await ctx.db.insert("subagentRuns", {
          runId: `pending-${offset}`,
          parentRunId: root.runId!,
          rootCancellationEpoch: root.cancellationEpoch,
          dedupKey: `pending-${offset}`,
          payloadFingerprint: "fixture",
          rootAssignmentId: root._id,
          actorAssignmentId: root._id,
          depth: 1,
          messagesReceived: 0,
          parentNotesSent: 0,
          childAssignmentId: assignmentId,
          childThreadId: source.threadId,
          agent: "Helper",
          actorAgent: root.agent,
          status: "running",
          deliveryStatus: "pending",
          deliveryToken: "fixture",
          coordinateHandle: "fixture",
          errorCode: null,
          createdAt: Date.now(),
          sequence: offset,
          events: [],
        });

      const messages = (await ctx.runQuery(args.getMessages as FunctionHandle<"query">, {
        messageIds: source.messageIds,
      })) as MessageDoc[];

      const { requests } = await collectPause(ctx, messages, new Set());

      const inboxId = await ctx.db.insert("inbox", {
        assignmentId,
        runId: root.runId!,
        messageId: source.messageIds[0],
        sequence: 0,
        kind: "user",
      });

      await ctx.db.patch("assignments", assignmentId, {
        approvalBlocked: true,
        queuedMessages: 1,
        approvals: {
          inboxId,
          epoch: root.cancellationEpoch,
          getMessages: args.getMessages,
          addMessages: args.addMessages,
          requests,
        },
      });
    }

    // Terminal history fills the query's entire 58-row hard maximum too.
    for (
      let offset = HOST_LIMITS.activeChildrenPerRoot.max;
      offset < HOST_LIMITS.runLaunches.max + HOST_LIMITS.sideRunsPerRun.max;
      offset++
    )
      await ctx.db.insert("subagentRuns", {
        runId: `history-${offset}`,
        parentRunId: root.runId!,
        rootCancellationEpoch: root.cancellationEpoch,
        dedupKey: `history-${offset}`,
        payloadFingerprint: "x".repeat(3 << 10),
        rootAssignmentId: root._id,
        actorAssignmentId: root._id,
        depth: 1,
        messagesReceived: 0,
        parentNotesSent: 0,
        agent: "Helper",
        actorAgent: root.agent,
        status: "completed",
        deliveryStatus: "accepted",
        deliveryToken: "fixture",
        coordinateHandle: "fixture",
        errorCode: null,
        createdAt: Date.now(),
        sequence: offset,
        events: [],
      });

    await ctx.db.patch("assignments", root._id, {
      activeRuns: HOST_LIMITS.activeChildrenPerRoot.max,
      limits: {
        ...root.limits,
        activeChildrenPerRoot: HOST_LIMITS.activeChildrenPerRoot.max,
        runLaunches: HOST_LIMITS.runLaunches.max,
        sideRunsPerRun: HOST_LIMITS.sideRunsPerRun.max,
      },
      nextRunSequence: HOST_LIMITS.runLaunches.max + HOST_LIMITS.sideRunsPerRun.max,
    });

    if (args.sources.length * LIMITS.approvalsPerPause !== 256) throw new Error("NOT_MAXIMUM");

    return null;
  },
});
