/** Native Workflow supplies bounded background capacity and non-retried action
 * dispatch. Completion closes crash receipts and removes the finite journal. */
import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { vResultValidator } from "@convex-dev/workpool";
import { childLane } from "../workflows/lanes.js";
import { internalMutation } from "../_generated/server.js";
import { textArgs } from "./values.js";
import { findReceipt } from "../receipts/records.js";
import { textScope, type TextJob } from "./jobs.js";

export const work = childLane
  .define({ args: { ...textArgs, handle: v.string() }, returns: v.null() })
  .handler(async (step, { handle, ...args }): Promise<null> => {
    await step.runAction(handle as FunctionHandle<"action", typeof args, null>, args, {
      name: "textTask",
      retry: false,
    });

    return null;
  });

/** Preparation failure is known; a crashed dispatched action is unknown.
 * Successful workers already closed their receipt in the native-write mutation. */
export const done = internalMutation({
  args: {
    workflowId: v.string(),
    result: vResultValidator,
    context: v.object({ ...textArgs, assignmentId: v.id("assignments") }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const receipt = await findReceipt(ctx, textScope(args.context.assignmentId), args.context.key);

    if (receipt?.status === "running") {
      const job = receipt.result as TextJob | undefined;

      await ctx.db.patch("receipts", receipt._id, {
        status: job?.phase === "dispatched" ? "unknown" : "failed",
        leaseUntil: undefined,
        result: undefined,
      });
    }

    await childLane.cleanup(ctx, args.workflowId as import("@convex-dev/workflow").WorkflowId);

    return null;
  },
});
