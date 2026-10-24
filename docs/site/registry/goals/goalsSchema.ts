import { defineSchema, defineTable, type DataModelFromSchemaDefinition } from "convex/server";
import { v } from "convex/values";

/**
 * Merge into the host schema; each field is used by goal_set/goal_check.
 * Native thread metadata has no custom field for a run goal. See
 * @convex-dev/agent/src/client/threads.ts:18-30,55-63 (version 0.7.7).
 */
export const goalTables = {
  agevexGoals: defineTable({
    subject: v.string(),
    threadId: v.string(),
    runId: v.string(),
    goal: v.string(),
  }).index("by_owner_thread_run", ["subject", "threadId", "runId"]),
};
const schema = defineSchema(goalTables);
export type GoalDataModel = DataModelFromSchemaDefinition<typeof schema>;
