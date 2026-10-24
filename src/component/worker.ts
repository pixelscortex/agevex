import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { internalAction } from "./_generated/server.js";
import { api } from "./_generated/api.js";

/** One paid slice, never retried. Workflow only journals ids, never transcript text. */
export const dispatch = internalAction({
  args: { assignmentId: v.id("assignments"), executionId: v.string(), sliceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.runQuery(api.queue.execution, { assignmentId: args.assignmentId });
    if (!row || row.cancelled || row.turnToken !== args.executionId) return null;
    try {
      await ctx.runAction(
        row.runTurn as FunctionHandle<
          "action",
          { assignmentId: string; turnToken: string; sliceId: string },
          null
        >,
        { assignmentId: args.assignmentId, turnToken: args.executionId, sliceId: args.sliceId },
      );
    } catch {
      await ctx.runMutation(api.queue.ambiguous, {
        assignmentId: args.assignmentId,
        turnToken: args.executionId,
      });
    }
    return null;
  },
});
