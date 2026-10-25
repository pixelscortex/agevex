// Registry source installed into the host Convex app; not an agevex component.
import { defineSchema, defineTable, type DataModelFromSchemaDefinition } from "convex/server";
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

export type TodoDataModel = DataModelFromSchemaDefinition<typeof schema>;
