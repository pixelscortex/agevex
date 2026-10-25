import type { FunctionHandle } from "convex/server";
import type { MessageDoc } from "@convex-dev/agent";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { pendingGeneration } from "./schema.js";
import { approvalKey, saveResponses } from "./approvals.js";
import { wake } from "./queue.js";

/** Exactly one recorded placeholder per transaction, including native payload reads. */
async function finalize(ctx: MutationCtx, pending: typeof pendingGeneration.type) {
  const [message]: ({ status: string } | null)[] = await ctx.runQuery(
    pending.getMessages as FunctionHandle<"query">,
    { messageIds: [pending.messageId] },
  );
  // Native ids survive order reuse. Deletion and an already terminal message
  // are both no-ops; finalizeMessage also compares pending status atomically.
  if (message?.status === "pending")
    await ctx.runMutation(pending.finalizeMessage as FunctionHandle<"mutation">, {
      messageId: pending.messageId,
      result: { status: "failed", error: "CANCELLED" },
    });
}

/** Backstop for an action that crashed or was killed before its abort listener. */
const cleanupArgs = {
  assignmentId: v.id("assignments"),
  pending: v.optional(pendingGeneration),
  approvalEpoch: v.optional(v.number()),
  notes: v.optional(v.object({ messageIds: v.array(v.string()), deleteMessages: v.string() })),
};

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

export const cleanupBatch = internalMutation({
  args: cleanupArgs,
  returns: v.null(),
  handler: async (ctx, { assignmentId, pending, approvalEpoch, notes }) => {
    // Stream creation is tracked atomically too: never list a thread's streams
    // after cancellation, when a fresh generation may already own another one.
    if (pending?.stream) {
      try {
        await ctx.runMutation(pending.stream.abort as FunctionHandle<"mutation">, {
          streamId: pending.stream.id,
          reason: "CANCELLED",
        });
      } catch (error) {
        // Native deletion may already have removed this exact stream.
        if (
          !(error instanceof Error) ||
          !error.message.includes("Stream not found: " + pending.stream.id)
        )
          throw error;
      }
    }
    if (pending) await finalize(ctx, pending);
    const row = await ctx.db.get("assignments", assignmentId);
    if (
      pending &&
      row?.pendingGeneration?.messageId === pending.messageId &&
      row.pendingGeneration.epoch === pending.epoch
    )
      await ctx.db.patch("assignments", assignmentId, { pendingGeneration: undefined });
    if (notes?.messageIds.length) {
      // Cancel passed only <=24 exact ids, never native note bodies. Each
      // cleanup transaction deletes one <=50 KiB provisional note; the finite
      // chain stops after those ids and then continues approval cleanup.
      await ctx.runMutation(notes.deleteMessages as FunctionHandle<"mutation">, {
        messageIds: notes.messageIds.slice(0, 1),
      });
      await ctx.scheduler.runAfter(0, internal.cancellation.cleanup, {
        assignmentId,
        approvalEpoch,
        ...(notes.messageIds.length > 1
          ? {
              notes: {
                ...notes,
                messageIds: notes.messageIds.slice(1),
              },
            }
          : {}),
      });
      return null;
    }
    const approvals = row?.approvals;
    if (!row || !approvals?.cleanupPending || approvals.epoch !== approvalEpoch) return null;
    const request = approvals.requests[0];
    const messageId = request.messageId;
    // One exact request document per transaction (<= 1 MiB), plus native save
    // lookups and at most one placeholder/stream: never read sixteen huge docs
    // together. Chained jobs settle <= approvalsPerPause recorded requests in
    // total; the guard remains set until the final native save commits.
    const [message]: (MessageDoc | null)[] = await ctx.runQuery(
      approvals.getMessages as FunctionHandle<"query">,
      { messageIds: [messageId] },
    );
    const content = message?.message?.content;
    const responses = [];
    const deniedCalls = [];
    if (message?.message?.role === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        if (request.deferred) {
          if (part.type === "tool-call" && (await approvalKey(part.toolCallId)) === request.key) {
            deniedCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName });
            break;
          }
          continue;
        }
        if (part.type !== "tool-approval-request") continue;
        const key = await approvalKey(part.approvalId);
        if (key !== request.key) continue;
        const call = content.find(
          (candidate) => candidate.type === "tool-call" && candidate.toolCallId === part.toolCallId,
        );
        if (call?.type !== "tool-call") throw new Error("APPROVAL_CALL_NOT_FOUND");
        // Even an answered request has no result until the gated continuation
        // runs. Cancel terminates that call without repeating its decision.
        deniedCalls.push({
          toolCallId: part.toolCallId,
          toolName: call.toolName,
          ...(request.providerExecuted ? { providerExecuted: true as const } : {}),
        });
        if (!approvals.resolved.includes(0))
          responses.push({
            approvalId: part.approvalId,
            approved: false,
            reason: "cancelled",
            ...(request.providerExecuted ? { providerExecuted: true as const } : {}),
          });
        break;
      }
    }
    if (deniedCalls.length)
      await saveResponses(
        ctx,
        { ...row, messageId, addMessages: approvals.addMessages },
        responses,
        deniedCalls,
      );
    // Native deletion is also terminal for this exact reference. Never search
    // another order/message for a replacement after cancellation.
    const remaining = approvals.requests
      .map((request, index) => ({ request, resolved: approvals.resolved.includes(index) }))
      .filter((_, index) => index !== 0);
    if (remaining.length) {
      await ctx.db.patch("assignments", assignmentId, {
        approvals: {
          ...approvals,
          requests: remaining.map(({ request }) => request),
          resolved: remaining.flatMap(({ resolved }, index) => (resolved ? [index] : [])),
        },
      });
      await ctx.scheduler.runAfter(0, internal.cancellation.cleanup, {
        assignmentId,
        approvalEpoch,
      });
    } else {
      await ctx.db.patch("assignments", assignmentId, {
        approvals: undefined,
        approvalBlocked: false,
      });
      await wake(ctx, { ...row, approvals: undefined, approvalBlocked: false });
    }
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
