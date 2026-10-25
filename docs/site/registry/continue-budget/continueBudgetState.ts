import {
  internalMutationGeneric,
  internalQueryGeneric,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import { CONSENT_LIMITS } from "./continueBudget.js";
import type { ConsentDataModel } from "./continueBudgetSchema.js";

const query = internalQueryGeneric as QueryBuilder<ConsentDataModel, "internal">;
const mutation = internalMutationGeneric as MutationBuilder<ConsentDataModel, "internal">;
const consent = { subject: v.string(), threadId: v.string(), approvalId: v.string() };

// Index fields are limited to 1 KiB each, and the approval id is chosen by the
// model provider. Reject what cannot be indexed instead of truncating it: a
// truncated id could make two approvals look like one consent.
const checkId = (approvalId: string) => {
  if (
    !approvalId ||
    new TextEncoder().encode(approvalId).byteLength > CONSENT_LIMITS.approvalIdBytes
  )
    throw new Error("INVALID_APPROVAL_ID");
};

/**
 * Record explicit consent. Call it from the host mutation that ALSO calls core
 * `respond({ approved: true })`, so both commit or neither does. Idempotent.
 * subject/threadId are core facts (<= 128 UTF-8 bytes); a row is < 2 KiB, and
 * unique() reads at most two rows (convex/src/server/impl/query_impl.ts:334-343).
 */
export const record = mutation({
  args: consent,
  returns: v.null(),
  handler: async (ctx, args) => {
    checkId(args.approvalId);
    const row = await ctx.db
      .query("agevexBudgetConsents")
      .withIndex("by_consent", (q) =>
        q.eq("subject", args.subject).eq("threadId", args.threadId).eq("approvalId", args.approvalId),
      )
      .unique();
    if (!row) await ctx.db.insert("agevexBudgetConsents", args);
    return null;
  },
});

/** True only for consent that `record` stored for this exact owner, thread and approval. */
export const has = query({
  args: consent,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    checkId(args.approvalId);
    const row = await ctx.db
      .query("agevexBudgetConsents")
      .withIndex("by_consent", (q) =>
        q.eq("subject", args.subject).eq("threadId", args.threadId).eq("approvalId", args.approvalId),
      )
      .unique();
    return row !== null;
  },
});

/**
 * Bounded host cleanup; rows outlive threads. Deletes at most
 * CONSENT_LIMITS.cleanupBatch rows (< 2 KiB each, < 256 KiB) for the subject,
 * optionally one thread, and reports `done: false` when more remain. Nothing
 * reschedules itself.
 */
export const cleanup = mutation({
  args: { subject: v.string(), threadId: v.optional(v.string()) },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const threadId = args.threadId;
    const rows = await ctx.db
      .query("agevexBudgetConsents")
      .withIndex("by_consent", (q) =>
        threadId === undefined
          ? q.eq("subject", args.subject)
          : q.eq("subject", args.subject).eq("threadId", threadId),
      )
      .take(CONSENT_LIMITS.cleanupBatch + 1);
    const batch = rows.slice(0, CONSENT_LIMITS.cleanupBatch);
    for (const row of batch) await ctx.db.delete("agevexBudgetConsents", row._id);
    return { deleted: batch.length, done: rows.length <= CONSENT_LIMITS.cleanupBatch };
  },
});
