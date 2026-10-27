/** Workflow completion's sole fenced failure mutation; no scheduled detector. */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server.js";
import { failWorkflow as finalize } from "./finish.js";

/** Duplicate, cancelled and superseded completions cannot touch a new turn. */
export const failWorkflow = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    workflowId: v.string(),
    executionId: v.string(),
    epoch: v.number(),
  },
  returns: v.null(),
  handler: (ctx, args) => finalize(ctx, args),
});
