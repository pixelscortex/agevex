/**
 * Registered turn-lifecycle endpoints of one assignment (one managed thread).
 * Entry file only: every handler delegates to a module in queue/.
 *
 * Life of a turn: `accept` admits a send (queue/accept.ts) and wakes the
 * thread (queue/wake.ts reserves the head and rings the loop); the loop
 * workflow calls `next` for the queued token; each slice's host action
 * `claim`s (queue/claim.ts), writes natively through `write` (queue/write.ts,
 * approval pauses in queue/pause.ts), and ends with `continueTurn` +
 * `betweenSlices` (queue/slice.ts) or `finish` (queue/finish.ts). Approval
 * pauses resume via `respond`/`answer` (queue/responses.ts). Failures go
 * through `ambiguous`, `stalled`, `failWorkflow` and `sliceLimit`; `cancel`
 * (queue/cancel.ts) fences everything; `reconcile` re-rings a lost doorbell.
 * Tables: `assignments`, `inbox`, `runs`, `receipts`.
 */
import { v } from "convex/values";
import { api } from "./_generated/api.js";
import { mutation, query, internalMutation } from "./_generated/server.js";
import { activity as vActivity, receipt as vReceipt, scope, errorCode } from "./schema.js";
import { assignmentByThread } from "./queue/assignments.js";
import { acceptArgs, acceptSend, requestReceipt } from "./queue/accept.js";
import { nextQueuedTurn, reconcileDoorbell } from "./queue/wake.js";
import { claimArgs, claimSlice, vClaim } from "./queue/claim.js";
import { fencedWrite, writeArgs } from "./queue/write.js";
import { admitNextSlice, closeSlice } from "./queue/slice.js";
import { detectStall, finishTurn, markAmbiguous } from "./queue/finish.js";
import { answerDeferredCall, respondToApproval, vResponseResult } from "./queue/responses.js";
import { cancelRoot } from "./queue/cancel.js";
import { activityView, assignmentScope, executionView, vExecution } from "./queue/views.js";

/** Replay lookup for a host send, before any native save is attempted. */
export const lookupReceipt = query({
  args: { subject: v.string(), requestKey: v.string(), fingerprint: v.string() },
  returns: v.union(v.null(), vReceipt),
  handler: (ctx, args) => requestReceipt(ctx, args.subject, args.requestKey, args.fingerprint),
});

/** Preflight shares the host mutation's snapshot with its later native save.
 * Expected refusal must happen before that save: returning a receipt after a
 * write would commit an orphan prompt rather than rolling the transaction back.
 */
export const admission = query({
  args: { threadId: v.string(), subject: v.string() },
  returns: v.union(v.null(), vReceipt),
  handler: async (ctx, args) => {
    const row = await assignmentByThread(ctx, args.threadId);
    if (!row || row.subject !== args.subject) throw new Error("FORBIDDEN");

    if (row.turnStatus === "recovery_required")
      return {
        status: "rejected" as const,
        code: row.cancelled ? ("CANCELLED" as const) : ("RECOVERY_REQUIRED" as const),
      };
    if (row.queuedMessages >= row.limits.queueLength)
      return { status: "rejected" as const, code: "QUEUE_FULL" as const };
    return null;
  },
});

/** The thread's assignment scope and whether it is a public root. */
export const assignment = query({
  args: { threadId: v.string() },
  returns: v.union(v.null(), v.object({ ...scope.fields, root: v.boolean() })),
  handler: async (ctx, { threadId }) => {
    const row = await assignmentByThread(ctx, threadId);
    return row ? assignmentScope(row, threadId) : null;
  },
});

/** Admit one host send with its native prompt save; see queue/accept.ts. */
export const accept = mutation({
  args: acceptArgs,
  returns: vReceipt,
  handler: (ctx, args) => acceptSend(ctx, args),
});

/**
 * Claim one model slice, not an entire retriable action. A first slice consumes
 * the reserved inbox row, while subsequent slices require both continuation
 * state and a new slice id under the same execution token. Replayed or racing
 * calls therefore cannot pay for the same slice twice. Each slice arms its own
 * watchdog; lane wait and time between completed slices do not spend it. Consecutive child results
 * share a final prompt anchor, letting native context include the whole batch.
 * See queue/claim.ts.
 */
export const claim = mutation({
  args: claimArgs,
  returns: v.union(v.null(), vClaim),
  handler: (ctx, args) => claimSlice(ctx, args),
});

/** End the running turn, successfully or with a failure code; see
 * queue/finish.ts. */
export const finish = mutation({
  args: { assignmentId: v.id("assignments"), turnToken: v.string(), errorCode },
  returns: v.null(),
  handler: (ctx, args) => finishTurn(ctx, args),
});

/** worker.dispatch: the host action threw, so the slice outcome is unknown. */
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

/** The thread's public status for its owner. */
export const activity = query({
  args: { threadId: v.string(), subject: v.string() },
  returns: vActivity,
  handler: async (ctx, args) => {
    const row = await assignmentByThread(ctx, args.threadId);
    if (!row || row.subject !== args.subject) throw new Error("FORBIDDEN");

    return activityView(row);
  },
});

/** Execution metadata the host action polls; see queue/views.ts. */
export const execution = query({
  args: { assignmentId: v.id("assignments") },
  returns: v.union(v.null(), vExecution),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    return row ? executionView(row) : null;
  },
});

/** The loop workflow's step: the queued turn's token, or null to sleep. */
export const next = internalMutation({
  args: { assignmentId: v.id("assignments") },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { assignmentId }): Promise<string | null> => nextQueuedTurn(ctx, assignmentId),
});

/** A single transactional fence around the native mutation, including its save.
 * Checking in the action before calling a native mutation leaves a cancel race;
 * nested Convex mutations share this transaction, so cancellation wins or the
 * write commits before cancellation. Host tool mutations use this same path.
 * See queue/write.ts.
 */
export const write = mutation({
  args: writeArgs,
  handler: (ctx, args): Promise<unknown> => fencedWrite(ctx, args),
});

/** Approval responses MUST go through the authorized respond endpoint. A
 * response saved directly through Agent is not seen by this runtime.
 * See queue/responses.ts.
 */
export const respond = mutation({
  args: {
    assignmentId: v.id("assignments"),
    subject: v.string(),
    approvalId: v.string(),
    approved: v.boolean(),
    reason: v.optional(v.string()),
    addMessages: v.string(),
  },
  returns: vResponseResult,
  handler: (ctx, args) => respondToApproval(ctx, args),
});

/** Save a deferred native result and release its continuation atomically.
 * See queue/responses.ts for the read budget. */
export const answer = mutation({
  args: {
    assignmentId: v.id("assignments"),
    subject: v.string(),
    toolCallId: v.string(),
    text: v.string(),
  },
  returns: vResponseResult,
  handler: (ctx, args) => answerDeferredCall(ctx, args),
});

/** The host action finished one slice and will run another; see
 * queue/slice.ts. */
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
    await ctx.runMutation(api.queue.finish, {
      assignmentId: args.assignmentId,
      turnToken: args.executionId,
      errorCode: "SLICE_LIMIT",
    });
    return null;
  },
});

/** The loop workflow failed while this turn was in flight. */
export const failWorkflow = internalMutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string() },
  returns: v.null(),
  handler: (ctx, args) => markAmbiguous(ctx, args.assignmentId, args.executionId),
});

/** Cancel sets fences before canceling Workflow, which cannot abort actions.
 * See queue/cancel.ts. */
export const cancel = mutation({
  args: { assignmentId: v.id("assignments"), subject: v.string() },
  returns: v.array(v.object({ threadId: v.string(), agent: v.string() })),
  handler: (ctx, args) => cancelRoot(ctx, args),
});

/** The scheduled recovery check; see `reconcileDoorbell` in queue/wake.ts. */
export const reconcile = internalMutation({
  args: { assignmentId: v.id("assignments"), recoveryAt: v.optional(v.number()) },
  returns: v.null(),
  handler: (ctx, { assignmentId, recoveryAt }) => reconcileDoorbell(ctx, assignmentId, recoveryAt),
});
