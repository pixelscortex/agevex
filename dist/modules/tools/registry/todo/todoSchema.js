/**
 * Host schema snippet for one bounded todo list per owner and thread.
 * Installers spread todoTables into their schema; todoState uses the owner/thread
 * index for current-state reads, replacement writes and explicit host cleanup.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
/**
 * Spread into the host's defineSchema; no agevex component table is added.
 * Agent 0.7.7 only supports userId/title/summary metadata, so this small host
 * table is necessary: @convex-dev/agent/src/client/threads.ts:18-30,55-63.
 */
export const todoTables = {
    agevexTodos: defineTable({
        subject: v.string(),
        threadId: v.string(),
        todos: v.array(v.object({ id: v.string(), text: v.string(), done: v.boolean() })),
    }).index("by_owner_thread", ["subject", "threadId"]),
};
// A local model keeps this snippet type-safe without importing generated host
// files. A host may freely merge other tables into its own schema.
const schema = defineSchema(todoTables);
