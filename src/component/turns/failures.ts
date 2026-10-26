/**
 * Registered failure paths of a running turn: `ambiguous` (the host action
 * threw, so the slice outcome is unknown), `stalled` (the slice watchdog
 * fired) and `failWorkflow` (the loop workflow failed mid-turn). Each one
 * delegates to turns/finish.ts; paid generations are never retried.
 * Tables: `assignments`, `inbox`, `subagentRuns` (via escalate).
 */
import { v } from "convex/values";
import { mutation, internalMutation } from "../_generated/server.js";
import { detectStall, markAmbiguous } from "./finish.js";

/** workflows.worker.dispatch: the host action threw, so the slice outcome is unknown. */
export const ambiguous = mutation({
  args: { assignmentId: v.id("assignments"), turnToken: v.string() },
  returns: v.null(),
  handler: (ctx, args) => markAmbiguous(ctx, args.assignmentId, args.turnToken),
});

/** The slice watchdog fired: the action neither continued nor finished.
 * Detection only: never reassign an expired token or replay a generation. */
export const stalled = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    sliceId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: (ctx, args) => detectStall(ctx, args),
});

/** The loop workflow failed while this turn was in flight. */
export const failWorkflow = internalMutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string() },
  returns: v.null(),
  handler: (ctx, args) => markAmbiguous(ctx, args.assignmentId, args.executionId),
});
