import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { pendingGeneration } from "./schema.js";

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
  args: { assignmentId: v.id("assignments"), pending: pendingGeneration },
  returns: v.null(),
  handler: async (ctx, { assignmentId, pending }) => {
    // Stream creation is tracked atomically too: never list a thread's streams
    // after cancellation, when a fresh generation may already own another one.
    if (pending.stream) {
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
    await finalize(ctx, pending);
    const row = await ctx.db.get("assignments", assignmentId);
    if (
      row?.pendingGeneration?.messageId === pending.messageId &&
      row.pendingGeneration.epoch === pending.epoch
    )
      await ctx.db.patch("assignments", assignmentId, { pendingGeneration: undefined });
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
