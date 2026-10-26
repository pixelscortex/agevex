/** Native Workflow supplies background capacity and non-retried action dispatch.
 * A finite completion callback cleans each small journal; no idle job chain. */
import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { vResultValidator } from "@convex-dev/workpool";
import { childLane } from "../workflows/lanes.js";
import { internalMutation } from "../_generated/server.js";
import { textArgs } from "./values.js";

export const work = childLane
  .define({
    args: { ...textArgs, handle: v.string() },
    returns: v.null(),
  })
  .handler(async (step, { handle, ...args }): Promise<null> => {
    await step.runAction(handle as FunctionHandle<"action", typeof args, null>, args, {
      name: "textTask",
      retry: false,
    });

    return null;
  });

/** A crashed action is never retried. Its paid claim's finite expiry records
 * unknown status; cleanup only removes Workflow bookkeeping. */
export const done = internalMutation({
  args: {
    workflowId: v.string(),
    result: vResultValidator,
    context: v.object({ ...textArgs, assignmentId: v.id("assignments") }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.result.kind !== "success") {
      const row = await ctx.db.get("assignments", args.context.assignmentId);
      const field = args.context.kind === "title" ? "titleTask" : "summaryTask";
      const job = row?.[field];

      if (row && job?.key === args.context.key && ["queued", "running"].includes(job.status))
        await ctx.db.patch("assignments", row._id, {
          [field]: {
            ...job,
            status: job.dispatched ? "unknown" : "failed",
            again: undefined,
          },
        });
    }

    await childLane.cleanup(ctx, args.workflowId as import("@convex-dev/workflow").WorkflowId);

    return null;
  },
});
