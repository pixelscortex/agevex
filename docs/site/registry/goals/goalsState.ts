import {
  internalMutationGeneric,
  internalQueryGeneric,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import { goalScope, goalText } from "./goals.js";
import type { GoalDataModel } from "./goalsSchema.js";

const query = internalQueryGeneric as QueryBuilder<GoalDataModel, "internal">;
const mutation = internalMutationGeneric as MutationBuilder<GoalDataModel, "internal">;
const scope = { subject: v.string(), threadId: v.string(), runId: v.string() };

export const check = query({
  args: scope,
  returns: v.object({ goal: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    goalScope.parse(args);
    // One row: 4000 × 4 goal bytes + 3 × 1024 × 4 scope bytes + 1 KiB
    // overhead < 29 KiB. unique() takes at most TWO rows then rejects
    // duplicates (convex/src/server/impl/query_impl.ts:334-343): <58 KiB,
    // two docs and one query. Even two host-corrupted 1 MiB rows fit 16 MiB.
    // No history scan, model call, copied request content or native transcript.
    const row = await ctx.db
      .query("agevexGoals")
      .withIndex("by_owner_thread_run", (q) =>
        q.eq("subject", args.subject).eq("threadId", args.threadId).eq("runId", args.runId),
      )
      .unique();
    return { goal: row ? goalText.parse(row.goal) : null };
  },
});

export const set = mutation({
  args: { ...scope, goal: v.string() },
  returns: v.object({ goal: v.string() }),
  handler: async (ctx, args) => {
    const owner = goalScope.parse({
      subject: args.subject,
      threadId: args.threadId,
      runId: args.runId,
    });
    const goal = goalText.parse(args.goal);
    // Same <58 KiB / two-document read as check, one <29 KiB write and one query. The
    // transaction's index read serializes concurrent first writes for this run.
    const row = await ctx.db
      .query("agevexGoals")
      .withIndex("by_owner_thread_run", (q) =>
        q.eq("subject", owner.subject).eq("threadId", owner.threadId).eq("runId", owner.runId),
      )
      .unique();
    if (row) await ctx.db.patch("agevexGoals", row._id, { goal });
    else await ctx.db.insert("agevexGoals", { ...owner, goal });
    return { goal };
  },
});
