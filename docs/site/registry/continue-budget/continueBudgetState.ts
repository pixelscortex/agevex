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
const consent = {
  subject: v.string(),
  threadId: v.string(),
  approvalId: v.string(),
  runId: v.string(),
};

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
 * `respond({ approved: true })`, with the thread's current `activity.runId`, so
 * both commit or neither does. The run id binds the consent to the run that was
 * active when the user approved: an approval from one run can never unlock the
 * stop of another. Re-recording the same approval keeps the first row.
 * subject/threadId/runId are core facts (<= 128 UTF-8 bytes); a row is < 2 KiB,
 * and unique() reads at most two rows (convex/src/server/impl/query_impl.ts:334-343).
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

/**
 * Spend the consent: true exactly once, and only for this owner, thread,
 * approval AND the stopped run it was recorded for. Call it inside the resume
 * transaction (`resumeAfterBudgetStop` does): the delete commits with the budget
 * raise, cancel and fresh send, and rolls back with them if any step fails. A
 * mismatching run leaves the row untouched, so it stays usable for its own run.
 * Single-use matters because one approval must not authorize every later stop.
 */
export const consume = mutation({
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
    if (!row || row.runId !== args.runId) return false;
    await ctx.db.delete("agevexBudgetConsents", row._id);
    return true;
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
