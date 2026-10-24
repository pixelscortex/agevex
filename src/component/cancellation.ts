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
export const cleanup = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    pending: v.optional(pendingGeneration),
    approvalEpoch: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { assignmentId, pending, approvalEpoch }) => {
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
    const approvals = row?.approvals;
    if (!row || !approvals?.cleanupPending || approvals.epoch !== approvalEpoch) return null;
    const messageId = approvals.requests[0].messageId;
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
    const seen = new Set<number>();
    if (message?.message?.role === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        if (part.type !== "tool-approval-request") continue;
        const key = await approvalKey(part.approvalId);
        const index = approvals.requests.findIndex((request) => request.key === key);
        if (index < 0 || seen.has(index)) continue;
        const request = approvals.requests[index];
        if (request.messageId !== messageId) continue;
        const call = content.find(
          (candidate) => candidate.type === "tool-call" && candidate.toolCallId === part.toolCallId,
        );
        if (call?.type !== "tool-call") throw new Error("APPROVAL_CALL_NOT_FOUND");
        seen.add(index);
        // Even an answered request has no result until the gated continuation
        // runs. Cancel terminates that call without repeating its decision.
        deniedCalls.push({
          toolCallId: part.toolCallId,
          toolName: call.toolName,
          ...(request.providerExecuted ? { providerExecuted: true as const } : {}),
        });
        if (!approvals.resolved.includes(index))
          responses.push({
            approvalId: part.approvalId,
            approved: false,
            reason: "cancelled",
            ...(request.providerExecuted ? { providerExecuted: true as const } : {}),
          });
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
      .filter(({ request }) => request.messageId !== messageId);
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
