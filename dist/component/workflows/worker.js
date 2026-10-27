/** One paid model slice is one non-retried Workpool action. Thrown errors and
 * killed/cancelled steps reach Workflow's ordinary failure completion path.
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server.js";
import { api } from "../_generated/api.js";
/** Workflow journals ids only; host generation owns the in-action deadline. */
export const dispatch = internalAction({
    args: { assignmentId: v.id("assignments"), executionId: v.string(), sliceId: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        const row = await ctx.runQuery(api.turns.slices.execution, { assignmentId: args.assignmentId });
        if (!row || row.cancelled || row.turnToken !== args.executionId)
            return null;
        await ctx.runAction(row.runTurn, { assignmentId: args.assignmentId, turnToken: args.executionId, sliceId: args.sliceId });
        return null;
    },
});
