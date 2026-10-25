/**
 * Cancellation cleanup that cannot fit in `queue.cancel`'s own budget.
 * Entry file only: the native cleanup steps live in cancellation/cleanup.ts.
 *
 * Cancel schedules one `cleanup` per affected assignment. It aborts the
 * execution's tracked native stream, fails its pending placeholder message,
 * and then denies the recorded approval/deferred requests one per transaction
 * (each reads one exact native message of up to 1 MiB), chaining itself until
 * none remain and finally releasing the pause. If a native write fails, the
 * assignment is parked in `recovery_required` with CLEANUP_FAILED rather than
 * left half-cleaned. `close` is the one stale write a lost turn may still do:
 * fail its own placeholder. Touches `assignments` only; native writes go
 * through the recorded Agent handles.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { pendingGeneration } from "./schema.js";
import {
  continueOrRelease,
  denyFirstRequest,
  failPendingGeneration,
  finalize,
} from "./cancellation/cleanup.js";

/** Backstop for an action that crashed or was killed before its abort listener. */
const cleanupArgs = {
  assignmentId: v.id("assignments"),
  pending: v.optional(pendingGeneration),
  approvalEpoch: v.optional(v.number()),
};

/** Run one cleanup step as a nested savepoint; on failure, park the
 * assignment with CLEANUP_FAILED if this job still owns the cleanup. */
export const cleanup = internalMutation({
  args: cleanupArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      // A nested mutation is a savepoint: failed native writes roll back while
      // this outer transaction can publish a recoverable, typed failure.
      await ctx.runMutation(internal.cancellation.cleanupBatch, args);
    } catch {
      const row = await ctx.db.get("assignments", args.assignmentId);
      if (
        row &&
        ((row.approvals?.cleanupPending && row.approvals.epoch === args.approvalEpoch) ||
          (args.pending &&
            row.pendingGeneration?.messageId === args.pending.messageId &&
            row.pendingGeneration.epoch === args.pending.epoch))
      )
        await ctx.db.patch("assignments", row._id, {
          turnStatus: "recovery_required",
          errorCode: "CLEANUP_FAILED",
          approvals: row.approvals ? { ...row.approvals, cleanupPending: false } : undefined,
        });
    }
    return null;
  },
});

/** One cleanup step: the pending generation (if any), then the first
 * remaining recorded request of the cancelled pause. */
export const cleanupBatch = internalMutation({
  args: cleanupArgs,
  returns: v.null(),
  handler: async (ctx, { assignmentId, pending, approvalEpoch }) => {
    if (pending) await failPendingGeneration(ctx, pending);

    const row = await ctx.db.get("assignments", assignmentId);
    if (
      pending &&
      row?.pendingGeneration?.messageId === pending.messageId &&
      row.pendingGeneration.epoch === pending.epoch
    )
      await ctx.db.patch("assignments", assignmentId, { pendingGeneration: undefined });

    const approvals = row?.approvals;
    if (!row || !approvals?.cleanupPending || approvals.epoch !== approvalEpoch) return null;

    await denyFirstRequest(ctx, row, approvals);
    await continueOrRelease(ctx, row, approvals, approvalEpoch);
    return null;
  },
});

/** The only stale write allowed: close this execution/epoch's own placeholder. */
export const close = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    epoch: v.number(),
    messageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const pending = row?.pendingGeneration;
    if (
      !pending ||
      pending.messageId !== args.messageId ||
      pending.executionId !== args.executionId ||
      pending.epoch !== args.epoch
    )
      return null;

    await finalize(ctx, pending);
    await ctx.db.patch("assignments", args.assignmentId, { pendingGeneration: undefined });
    return null;
  },
});
