import { defineSchema, defineTable, type DataModelFromSchemaDefinition } from "convex/server";
import { v } from "convex/values";

/**
 * Merge into the host schema. One row records that an owner explicitly approved
 * one `continue_budget` approval on one thread. Core keeps approval decisions
 * inside the native Agent transcript and exposes no read-only "was it approved"
 * query, and reading the transcript to decide anything is not allowed, so the
 * host's approve action records the consent here in the same transaction as the
 * core `respond` call. Every field is read by `hasConsent`.
 */
export const consentTables = {
  agevexBudgetConsents: defineTable({
    subject: v.string(),
    threadId: v.string(),
    approvalId: v.string(),
  }).index("by_consent", ["subject", "threadId", "approvalId"]),
};
const schema = defineSchema(consentTables);
export type ConsentDataModel = DataModelFromSchemaDefinition<typeof schema>;
