/**
 * Registered endpoints of one running turn's paid model slices.
 *
 * Life of a turn: `turns.send.accept` admits a send and wakes the thread
 * (turns/wake.ts reserves the head and rings the loop); the loop workflow
 * calls `turns.loop.next` for the queued token; each slice's host action
 * `claim`s (turns/claim.ts), polls `execution` (turns/views.ts), writes
 * natively through `write` (turns/write.ts, approval pauses in
 * turns/pause.ts), and ends with `continueTurn` (turns/boundaries.ts) or
 * `finish` (turns/finish.ts); between two slices the turn workflow's own
 * step runs `betweenSlices` (turns/boundaries.ts), and `sliceLimit` ends a
 * turn that used every slice. Approval pauses resume via turns/approvals.ts;
 * failures land in turns/failures.ts; turns/cancel.ts fences everything.
 * Tables: `assignments`, `inbox`, `runs`, `receipts`.
 */
import { v } from "convex/values";
import { api } from "../_generated/api.js";
import { mutation, query, internalMutation } from "../_generated/server.js";
import { errorCode } from "../schema.js";
import { claimArgs, claimSlice, vClaim } from "./claim.js";
import { fencedWrite, writeArgs } from "./write.js";
import { admitNextSlice, closeSlice } from "./boundaries.js";
import { finishTurn } from "./finish.js";
import { executionView, vExecution } from "./views.js";

/**
 * Claim one model slice, not an entire retriable action. A first slice consumes
 * the reserved inbox row, while subsequent slices require both continuation
 * state and a new slice id under the same execution token. Replayed or racing
 * calls therefore cannot pay for the same slice twice. Each slice arms its own
 * watchdog; lane wait and time between completed slices do not spend it. Consecutive child results
 * share a final prompt anchor, letting native context include the whole batch.
 * See turns/claim.ts.
 */
export const claim = mutation({
  args: claimArgs,
  returns: v.union(v.null(), vClaim),
  handler: (ctx, args) => claimSlice(ctx, args),
});

/** End the running turn, successfully or with a failure code; see
 * turns/finish.ts. */
export const finish = mutation({
  args: { assignmentId: v.id("assignments"), turnToken: v.string(), errorCode },
  returns: v.null(),
  handler: (ctx, args) => finishTurn(ctx, args),
});

/** Execution metadata the host action polls; see turns/views.ts. */
export const execution = query({
  args: { assignmentId: v.id("assignments") },
  returns: v.union(v.null(), vExecution),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    return row ? executionView(row) : null;
  },
});

/** A single transactional fence around the native mutation, including its save.
 * Checking in the action before calling a native mutation leaves a cancel race;
 * nested Convex mutations share this transaction, so cancellation wins or the
 * write commits before cancellation. Host tool mutations use this same path.
 * See turns/write.ts.
 */
export const write = mutation({
  args: writeArgs,
  handler: (ctx, args): Promise<unknown> => fencedWrite(ctx, args),
});

/** The host action finished one slice and will run another; see
 * turns/boundaries.ts. */
export const continueTurn = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    cancellationEpoch: v.number(),
    messageId: v.string(),
  },
  returns: v.null(),
  handler: (ctx, args) => closeSlice(ctx, args),
});

/** Phase 1c's seam: all between-slice state checks belong in this mutation.
 * Returns the token to run another slice, or null to end the turn workflow. */
export const betweenSlices = internalMutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, args) => admitNextSlice(ctx, args),
});

/** The turn workflow ran out of slices: finish the turn with SLICE_LIMIT. */
export const sliceLimit = internalMutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(api.turns.slices.finish, {
      assignmentId: args.assignmentId,
      turnToken: args.executionId,
      errorCode: "SLICE_LIMIT",
    });
    return null;
  },
});
