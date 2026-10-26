/**
 * Host schema snippet for single-use spending consent.
 * The installer merges these tables into its Convex schema; state handlers
 * bind each approval to its owner, thread and run and retain spent receipts.
 */
import { type DataModelFromSchemaDefinition } from "convex/server";
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
export declare const consentTables: {
    agevexBudgetConsents: import("convex/server").TableDefinition<import("convex/values").VObject<{
        runId: string;
        threadId: string;
        subject: string;
        approvalId: string;
        spent: boolean;
    }, {
        subject: import("convex/values").VString<string, "required">;
        threadId: import("convex/values").VString<string, "required">;
        approvalId: import("convex/values").VString<string, "required">;
        runId: import("convex/values").VString<string, "required">;
        spent: import("convex/values").VBoolean<boolean, "required">;
    }, "required", "runId" | "threadId" | "subject" | "approvalId" | "spent">, {
        by_consent: ["subject", "threadId", "approvalId", "_creationTime"];
        by_thread: ["subject", "threadId", "_creationTime"];
    }, {}, {}>;
};
declare const schema: import("convex/server").SchemaDefinition<{
    agevexBudgetConsents: import("convex/server").TableDefinition<import("convex/values").VObject<{
        runId: string;
        threadId: string;
        subject: string;
        approvalId: string;
        spent: boolean;
    }, {
        subject: import("convex/values").VString<string, "required">;
        threadId: import("convex/values").VString<string, "required">;
        approvalId: import("convex/values").VString<string, "required">;
        runId: import("convex/values").VString<string, "required">;
        spent: import("convex/values").VBoolean<boolean, "required">;
    }, "required", "runId" | "threadId" | "subject" | "approvalId" | "spent">, {
        by_consent: ["subject", "threadId", "approvalId", "_creationTime"];
        by_thread: ["subject", "threadId", "_creationTime"];
    }, {}, {}>;
}, true>;
export type ConsentDataModel = DataModelFromSchemaDefinition<typeof schema>;
export {};
