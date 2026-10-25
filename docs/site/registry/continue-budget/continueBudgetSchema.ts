import { defineSchema, defineTable, type DataModelFromSchemaDefinition } from "convex/server";
import { v } from "convex/values";

/**
 * Merge into the host schema. One row records that an owner explicitly approved
 * one `continue_budget` approval on one thread. Core keeps approval decisions
 * inside the native Agent transcript and exposes no read-only "was it approved"
 * query, and reading the transcript to decide anything is not allowed, so the
 * host's approve action records the consent here in the same transaction as the
 * core `respond` call. The row is single-use and bound to the run that was
 * active when the user approved (`activity.runId`): `consume` deletes it only
 * for the stop of that exact run. Every field is read by `consume`.
 */
export const consentTables = {
  agevexBudgetConsents: defineTable({
    subject: v.string(),
    threadId: v.string(),
    approvalId: v.string(),
    runId: v.string(),
  }).index("by_consent", ["subject", "threadId", "approvalId"]),
};
const schema = defineSchema(consentTables);
export type ConsentDataModel = DataModelFromSchemaDefinition<typeof schema>;
