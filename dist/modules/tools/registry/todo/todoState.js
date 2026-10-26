/**
 * Internal host queries and mutations for durable thread todo lists.
 * Tool factories provide fenced ownership facts; validation repeats at the data
 * boundary. Bounded cleanup is driven by the host rather than a scheduled chain.
 */
import { internalMutationGeneric, internalQueryGeneric, } from "convex/server";
import { v } from "convex/values";
import { TODO_LIMITS, todoList } from "./todo.js";
const query = internalQueryGeneric;
const mutation = internalMutationGeneric;
const scope = { subject: v.string(), threadId: v.string() };
const result = {
    todos: v.array(v.object({ id: v.string(), text: v.string(), done: v.boolean() })),
};
/** Internal only: callers must originate in core's authorized ToolContext. */
export const read = query({
    args: scope,
    returns: v.object(result),
    handler: async (ctx, args) => {
        // subject/threadId are core-validated facts (<= LIMITS.factBytes = 128
        // UTF-8 bytes each). One row is <= 32 KiB list + 2 × 128 scope bytes + 1 KiB
        // overhead < 34 KiB. unique() reads at most TWO rows (convex/src/server/
        // impl/query_impl.ts:334-343), then rejects duplicates: < 68 KiB / two docs
        // / one query, far below 16 MiB / 32,000 docs / 4096 queries. Even two
        // host-corrupted 1 MiB documents remain below the transaction read limit.
        const row = await ctx.db
            .query("agevexTodos")
            .withIndex("by_owner_thread", (q) => q.eq("subject", args.subject).eq("threadId", args.threadId))
            .unique();
        return { todos: todoList.parse(row?.todos ?? []) };
    },
});
/** Replace the bounded list inside core's fenced tool mutation; indexed lookup serializes first writes. */
export const write = mutation({
    args: { ...scope, ...result },
    returns: v.object(result),
    handler: async (ctx, args) => {
        const owner = { subject: args.subject, threadId: args.threadId };
        // The byte bound cannot be expressed as a Convex validator, so re-check it
        // here at the data boundary.
        const todos = todoList.parse(args.todos);
        // Same < 68 KiB / two-document read bound as above, plus one < 34 KiB
        // document written (a successful lookup contains at most one row).
        // The indexed read and insert/patch share a transaction, so concurrent
        // first writes cannot create two rows for the same subject and thread.
        const row = await ctx.db
            .query("agevexTodos")
            .withIndex("by_owner_thread", (q) => q.eq("subject", owner.subject).eq("threadId", owner.threadId))
            .unique();
        if (row)
            await ctx.db.patch("agevexTodos", row._id, { todos });
        else
            await ctx.db.insert("agevexTodos", { ...owner, todos });
        return { todos };
    },
});
/**
 * Bounded host cleanup. Rows outlive their threads (the host owns retention), so
 * call this from your own thread-deletion or retention job. One call deletes at
 * most TODO_LIMITS.cleanupBatch rows for the subject (optionally one thread) and
 * reports `done: false` when more remain, so the caller decides whether to call
 * again; nothing reschedules itself. Reads/deletes <= 128 rows of < 34 KiB =
 * < 4.3 MiB, 128 writes, one query: far below the 16 MiB / 16,000-write limits.
 */
export const cleanup = mutation({
    args: { subject: v.string(), threadId: v.optional(v.string()) },
    returns: v.object({ deleted: v.number(), done: v.boolean() }),
    handler: async (ctx, args) => {
        const threadId = args.threadId;
        const rows = await ctx.db
            .query("agevexTodos")
            .withIndex("by_owner_thread", (q) => threadId === undefined
            ? q.eq("subject", args.subject)
            : q.eq("subject", args.subject).eq("threadId", threadId))
            .take(TODO_LIMITS.cleanupBatch + 1);
        const batch = rows.slice(0, TODO_LIMITS.cleanupBatch);
        for (const row of batch)
            await ctx.db.delete("agevexTodos", row._id);
        return { deleted: batch.length, done: rows.length <= TODO_LIMITS.cleanupBatch };
    },
});
