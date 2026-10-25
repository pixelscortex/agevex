import { WorkflowManager } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";
import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { LIMITS } from "../limits.js";
export const manager = new WorkflowManager(components.workflow, {
  workpoolOptions: { retryActionsByDefault: false, logLevel: "ERROR" },
});
export const extract = manager
  .define({
    args: {
      artifactId: v.string(),
      attempt: v.number(),
      claim: v.string(),
      threadId: v.string(),
      // Thread owner when the caller knew it at admission (agevex slot). It rides
      // in the workflow args like threadId, so the worker never looks it up.
      subject: v.optional(v.string()),
      worker: v.string(),
      version: v.number(),
    },
    returns: v.null(),
  })
  .handler(async (step, args): Promise<null> => {
    if (args.version !== LIMITS.workflowVersion)
      throw new Error("UNKNOWN_EXTRACT_WORKFLOW_VERSION");
    // Workflow 0.4.10 src/client/step.ts:213 resolves function handles;
    // Convex 1.47 src/server/components/paths.ts:28 accepts existing handles.
    // Persist only ids here: payload JSON never enters its 1 MiB journal rows.
    await step.runAction(
      args.worker as FunctionHandle<"action">,
      {
        artifactId: args.artifactId,
        attempt: args.attempt,
        claim: args.claim,
        threadId: args.threadId,
        ...(args.subject === undefined ? {} : { subject: args.subject }),
      },
      { retry: false, name: "extract" },
    );
    return null;
  });
export const done = internalMutation({
  args: {
    workflowId: v.string(),
    result: vResultValidator,
    context: v.object({
      artifactId: v.string(),
      attempt: v.number(),
      claim: v.string(),
      onComplete: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // A crashed action has an unknown paid outcome. The lease covers crashes in
    // this callback too; neither path admits a new provider attempt.
    const { onComplete, ...fence } = args.context;
    await ctx.runMutation(internal.artifacts.abandon, fence);
    // Native Workflow completion runs even when the action failed after saving
    // a result (for example, a host usage hook failed). The callback must see
    // that terminal row too, without replaying any provider work. It is a
    // mutation in this same transaction, so callback writes commit atomically.
    if (onComplete)
      await ctx.runMutation(onComplete as FunctionHandle<"mutation">, {
        artifactId: fence.artifactId,
      });
    await manager.cleanup(ctx, args.workflowId as import("@convex-dev/workflow").WorkflowId);
    return null;
  },
});
