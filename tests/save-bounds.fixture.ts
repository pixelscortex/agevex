/** Exact assignment boundary before a genuine nested native save. */
import { getConvexSize, v } from "convex/values";
import { mutation } from "../src/component/_generated/server.js";
import { newRootAssignment } from "../src/component/turns/assignments.js";
import { LIMITS, resolveLimits } from "../src/component/limits.js";
import { fillAssignment } from "./assignment-envelope.fixture.js";

export const seed = mutation({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
    marker: v.boolean(),
    overflow: v.boolean(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("assignments", {
      ...newRootAssignment({
        subject: "alice",
        agent: "Main",
        threadId: args.threadId,
        runTurn: "opaque",
        limits: resolveLimits(),
      }),
      turnToken: "save",
      turnStatus: "running",
      promptMessageId: args.promptMessageId,
      turnReport: {
        promptMessageId: args.promptMessageId,
        maxMessages: 64,
        messageIds: Array.from({ length: 63 }, () => "m".repeat(LIMITS.messageIdBytes)),
      },
      ...(args.marker
        ? {
            activeTools: Array.from({ length: 16 }, (_, i) => ({
              key: String(i).padStart(64, "0"),
              name: "n".repeat(128),
            })),
          }
        : {}),
    });

    if (args.marker) await fillAssignment(ctx, id);
    else {
      const row = (await ctx.db.get("assignments", id))!;

      // Native test ids have the same encoding length as this real prompt id.
      const after = {
        ...row,
        turnReport: {
          ...row.turnReport!,
          messageIds: [...row.turnReport!.messageIds, args.promptMessageId],
        },
        modelStep: { messageId: args.promptMessageId, stepOrder: 0 },
      };

      const growth = LIMITS.assignmentBytes + Number(args.overflow) - getConvexSize(after);

      await ctx.db.patch("assignments", id, { runTurn: row.runTurn + "x".repeat(growth) });
    }

    return id;
  },
});
