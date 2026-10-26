/**
 * Host schema snippet for single-use spending consent.
 * The installer merges these tables into its Convex schema; state handlers
 * bind each approval to its owner, thread and run and retain spent receipts.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
/**
 * Merge into the host schema. One row records that an owner explicitly approved
 * one `continue_budget` approval on one thread. Core keeps approval decisions
 * inside the native Agent transcript and exposes no read-only "was it approved"
 * query, and reading the transcript to decide anything is not allowed, so the
 * host's approve action records the consent here in the same transaction as the
 * core `respond` call. The row is single-use and bound to the run that was
 * active when the user approved (`activity.runId`): `consume` marks it `spent`
 * only for the stop of that exact run. A spent row is kept (not deleted) so a
 * replayed approve cannot re-create consent: core `respond` replays for
 * LIMITS.receiptRetentionMs (7 days) without re-checking pending state. Every field is read by `consume`.
 */
export const consentTables = {
    agevexBudgetConsents: defineTable({
        subject: v.string(),
        threadId: v.string(),
        approvalId: v.string(),
        runId: v.string(),
        spent: v.boolean(),
    })
        .index("by_consent", ["subject", "threadId", "approvalId"])
        // Cleanup by owner thread and age: implicit _creationTime follows the fields.
        .index("by_thread", ["subject", "threadId"]),
};
const schema = defineSchema(consentTables);
