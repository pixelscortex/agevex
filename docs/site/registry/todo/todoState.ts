import {
  internalMutationGeneric,
  internalQueryGeneric,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import { v } from "convex/values";
import { todoList, todoScope } from "./todo.js";
import type { TodoDataModel } from "./todoSchema.js";

const query = internalQueryGeneric as QueryBuilder<TodoDataModel, "internal">;
const mutation = internalMutationGeneric as MutationBuilder<TodoDataModel, "internal">;
const scope = { subject: v.string(), threadId: v.string() };
const result = {
  todos: v.array(v.object({ id: v.string(), text: v.string(), done: v.boolean() })),
};

/** Internal only: callers must originate in core's authorized ToolContext. */
export const read = query({
  args: scope,
  returns: v.object(result),
  handler: async (ctx, args) => {
    todoScope.parse(args);
    // One row is <= 32 KiB list + 2 × 1024 × 4 scope bytes + 1 KiB overhead
    // = 41 KiB. unique() reads at most TWO rows (convex/src/server/impl/
    // query_impl.ts:334-343), then rejects duplicates: <= 82 KiB / two docs
    // / one query, far below 16 MiB / 32,000 docs / 4096 queries. Even two
    // host-corrupted 1 MiB documents remain below the transaction read limit.
    const row = await ctx.db
      .query("agevexTodos")
      .withIndex("by_owner_thread", (q) =>
        q.eq("subject", args.subject).eq("threadId", args.threadId),
      )
      .unique();
    return { todos: todoList.parse(row?.todos ?? []) };
  },
});

export const write = mutation({
  args: { ...scope, ...result },
  returns: v.object(result),
  handler: async (ctx, args) => {
    const owner = todoScope.parse({ subject: args.subject, threadId: args.threadId });
    const todos = todoList.parse(args.todos);
    // Same <=82 KiB / two-document read bound as above, plus one <=41 KiB
    // document written (a successful lookup contains at most one row).
    // The indexed read and insert/patch share a transaction, so concurrent
    // first writes cannot create two rows for the same subject and thread.
    const row = await ctx.db
      .query("agevexTodos")
      .withIndex("by_owner_thread", (q) =>
        q.eq("subject", owner.subject).eq("threadId", owner.threadId),
      )
      .unique();
    if (row) await ctx.db.patch("agevexTodos", row._id, { todos });
    else await ctx.db.insert("agevexTodos", { ...owner, todos });
    return { todos };
  },
});
