/**
 * Host schema snippet for one explicit goal per owner and thread.
 * Installers merge goalTables into their own schema; goalsState uses the
 * owner/thread index to read or replace the current goal without scanning history.
 */
import { type DataModelFromSchemaDefinition } from "convex/server";
/**
 * Merge into the host schema; each field is used by goal_set/goal_check. One row per
 * (subject, thread). The goal belongs to the thread, so the table grows with
 * threads, not runs.
 * Native thread metadata has no custom field for a run goal. See
 * @convex-dev/agent/src/client/threads.ts:18-30,55-63 (version 0.7.7).
 */
export declare const goalTables: {
    agevexGoals: import("convex/server").TableDefinition<import("convex/values").VObject<{
        threadId: string;
        subject: string;
        goal: string;
    }, {
        subject: import("convex/values").VString<string, "required">;
        threadId: import("convex/values").VString<string, "required">;
        goal: import("convex/values").VString<string, "required">;
    }, "required", "threadId" | "subject" | "goal">, {
        by_owner_thread: ["subject", "threadId", "_creationTime"];
    }, {}, {}>;
};
declare const schema: import("convex/server").SchemaDefinition<{
    agevexGoals: import("convex/server").TableDefinition<import("convex/values").VObject<{
        threadId: string;
        subject: string;
        goal: string;
    }, {
        subject: import("convex/values").VString<string, "required">;
        threadId: import("convex/values").VString<string, "required">;
        goal: import("convex/values").VString<string, "required">;
    }, "required", "threadId" | "subject" | "goal">, {
        by_owner_thread: ["subject", "threadId", "_creationTime"];
    }, {}, {}>;
}, true>;
export type GoalDataModel = DataModelFromSchemaDefinition<typeof schema>;
export {};
