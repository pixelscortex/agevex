/** The loop's atomic queue check returns work, its exact wake event, or stop. */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server.js";
import { nextQueuedTurn } from "./wake.js";

/** Workflow ownership fences old loops after cancellation and rotation. */
export const next = internalMutation({
  args: { assignmentId: v.id("assignments"), workflowId: v.string() },
  returns: v.union(
    v.object({ executionId: v.string(), epoch: v.number() }),
    v.object({ wakeEventId: v.string() }),
    v.null(),
  ),
  handler: (ctx, { assignmentId, workflowId }) => nextQueuedTurn(ctx, assignmentId, workflowId),
});
