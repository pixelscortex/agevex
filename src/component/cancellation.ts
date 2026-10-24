import type { FunctionHandle, PaginationResult } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation } from "./_generated/server.js";
import { LIMITS } from "./limits.js";

const target = v.object({
  threadId: v.string(),
  listMessages: v.string(),
  finalizeMessage: v.string(),
  cutoff: v.object({ messageId: v.string(), order: v.number(), stepOrder: v.number() }),
});
const args = { targets: v.array(target), cursor: v.union(v.string(), v.null()) };

/**
 * The host captures each native thread's last pending position in the same
 * transaction as the epoch fence. Only opaque handles and that position cross
 * the component boundary; scheduled cleanup never needs end-user authority.
 * Keeping all native finalization out of cancel lets the fence commit even
 * when the transcript exceeds Convex's 16 MiB transaction read ceiling.
 */
export const scheduleCleanup = mutation({
  args: { targets: v.array(target) },
  returns: v.null(),
  handler: async (ctx, { targets }) => {
    if (targets.length)
      await ctx.scheduler.runAfter(0, internal.cancellation.cleanup, { targets, cursor: null });
    return null;
  },
});

export const cleanup = internalMutation({
  args,
  returns: v.null(),
  handler: async (ctx, { targets, cursor }) => {
    const [current, ...rest] = targets;
    if (!current) return null;
    const pending: PaginationResult<{ _id: string; order: number; stepOrder: number }> =
      await ctx.runQuery(current.listMessages as FunctionHandle<"query">, {
        threadId: current.threadId,
        order: "desc",
        statuses: ["pending"],
        upToAndIncludingMessageId: current.cutoff.messageId,
        paginationOpts: { cursor, numItems: LIMITS.cancelCleanupBatch },
      });
    for (const message of pending.page) {
      // Agent's native cutoff bounds order only. Preserve stepOrder too, and
      // keep the fence effective even if the anchor message was later deleted
      // (the native query then has no upper bound). A later send allocates a new
      // order, so no continuation can close its generation's placeholder.
      if (
        message.order < current.cutoff.order ||
        (message.order === current.cutoff.order && message.stepOrder <= current.cutoff.stepOrder)
      )
        await ctx.runMutation(current.finalizeMessage as FunctionHandle<"mutation">, {
          messageId: message._id,
          result: { status: "failed", error: "CANCELLED" },
        });
    }
    // Follow the indexed cursor while finalization removes rows from the status
    // index. Each transaction reads one page for one thread, then yields; even
    // a root with several children cannot multiply this per-transaction bound.
    const remaining = pending.isDone ? rest : targets;
    if (remaining.length)
      await ctx.scheduler.runAfter(0, internal.cancellation.cleanup, {
        targets: remaining,
        cursor: pending.isDone ? null : pending.continueCursor,
      });
    return null;
  },
});
