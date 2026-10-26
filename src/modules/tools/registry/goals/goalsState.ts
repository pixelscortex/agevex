// Registry source installed into the host Convex app; not an agevex component.
import {
  internalMutationGeneric,
  internalQueryGeneric,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import { GOAL_LIMITS, goalText } from "./goals.js";
import type { GoalDataModel } from "./goalsSchema.js";

const query = internalQueryGeneric as QueryBuilder<GoalDataModel, "internal">;
const mutation = internalMutationGeneric as MutationBuilder<GoalDataModel, "internal">;
const scope = { subject: v.string(), threadId: v.string() };

export const check = query({
  args: { subject: v.string(), threadId: v.string() },
  returns: v.object({ goal: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    // subject/threadId are core-validated facts (<= LIMITS.factBytes = 128
    // UTF-8 bytes each). One row: 4000 × 4 goal bytes + 2 × 128 fact bytes
    // + 1 KiB overhead < 18 KiB. unique() takes at most TWO rows then rejects
    // duplicates (convex/src/server/impl/query_impl.ts:334-343): < 36 KiB,
    // two docs and one query. Even two host-corrupted 1 MiB rows fit 16 MiB.
    // No history scan, model call, copied request content or native transcript.
    const row = await ctx.db
      .query("agevexGoals")
      .withIndex("by_owner_thread", (q) =>
        q.eq("subject", args.subject).eq("threadId", args.threadId),
      )
      .unique();

    // The goal belongs to the thread, so it survives a budget resume, a retry or
    // any later request.
    return { goal: row ? goalText.parse(row.goal) : null };
  },
});

export const set = mutation({
  args: { ...scope, goal: v.string() },
  returns: v.object({ goal: v.string() }),
  handler: async (ctx, args) => {
    const owner = { subject: args.subject, threadId: args.threadId };
    // The trimmed 1-4000 character bound is not a Convex validator, so re-check
    // it at the data boundary.
    const goal = goalText.parse(args.goal);

    // Same < 36 KiB / two-document read as check, one < 18 KiB write and one query. The
    // transaction's index read serializes concurrent first writes for this run.
    const row = await ctx.db
      .query("agevexGoals")
      .withIndex("by_owner_thread", (q) =>
        q.eq("subject", owner.subject).eq("threadId", owner.threadId),
      )
      .unique();

    // One row per thread: a later goal_set replaces the goal.
    if (row) await ctx.db.patch("agevexGoals", row._id, { goal });
    else await ctx.db.insert("agevexGoals", { ...owner, goal });

    return { goal };
  },
});

/**
 * Bounded host cleanup. Rows outlive their threads (the host owns retention), so
 * call this from your own thread-deletion or retention job. One call deletes at
 * most GOAL_LIMITS.cleanupBatch rows for the subject (optionally one thread) and
 * reports `done: false` when more remain, so the caller decides whether to call
 * again; nothing reschedules itself. Reads/deletes <= 128 rows of < 18 KiB =
 * < 2.3 MiB, 128 writes, one query: far below the 16 MiB / 16,000-write limits.
 */
export const cleanup = mutation({
  args: { subject: v.string(), threadId: v.optional(v.string()) },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const threadId = args.threadId;

    const rows = await ctx.db
      .query("agevexGoals")
      .withIndex("by_owner_thread", (q) =>
        threadId === undefined
          ? q.eq("subject", args.subject)
          : q.eq("subject", args.subject).eq("threadId", threadId),
      )
      .take(GOAL_LIMITS.cleanupBatch + 1);

    const batch = rows.slice(0, GOAL_LIMITS.cleanupBatch);

    for (const row of batch) await ctx.db.delete("agevexGoals", row._id);

    return { deleted: batch.length, done: rows.length <= GOAL_LIMITS.cleanupBatch };
  },
});
