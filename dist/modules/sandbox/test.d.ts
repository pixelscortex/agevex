/**
 * convex-test registration for the optional sandbox component.
 * Offline host fixtures mount its schema and functions through register().
 * Native Agent remains a separate fixture dependency when exercising binary exports.
 */
import type { TestConvex } from "convex-test";
import { type GenericSchema, type SchemaDefinition } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
export declare const modules: Record<string, () => Promise<unknown>>;
/** Register only the sandbox component; mount the native Agent separately for exports. */
export declare function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(t: TestConvex<Schema>, name?: string): ComponentApi;
declare const _default: {
    register: typeof register;
    schema: SchemaDefinition<{
        sandboxes: import("convex/server").TableDefinition<import("convex/values").VObject<{
            sandboxId?: string | undefined;
            cleanupAt?: number | undefined;
            state: "stopped" | "unknown" | "ready" | "creating" | "deleting" | "deleted";
            claim: string;
            leaseUntil: number;
            provider: string;
            scopeKey: string;
            lastUsedAt: number;
            ttl: number;
        }, {
            scopeKey: import("convex/values").VString<string, "required">;
            provider: import("convex/values").VString<string, "required">;
            sandboxId: import("convex/values").VString<string | undefined, "optional">;
            state: import("convex/values").VUnion<"stopped" | "unknown" | "ready" | "creating" | "deleting" | "deleted", [import("convex/values").VLiteral<"creating", "required">, import("convex/values").VLiteral<"ready", "required">, import("convex/values").VLiteral<"stopped", "required">, import("convex/values").VLiteral<"unknown", "required">, import("convex/values").VLiteral<"deleting", "required">, import("convex/values").VLiteral<"deleted", "required">], "required", never>;
            lastUsedAt: import("convex/values").VFloat64<number, "required">;
            ttl: import("convex/values").VFloat64<number, "required">;
            claim: import("convex/values").VString<string, "required">;
            leaseUntil: import("convex/values").VFloat64<number, "required">;
            cleanupAt: import("convex/values").VFloat64<number | undefined, "optional">;
        }, "required", "state" | "claim" | "leaseUntil" | "provider" | "scopeKey" | "sandboxId" | "lastUsedAt" | "ttl" | "cleanupAt">, {
            by_scope: ["scopeKey", "_creationTime"];
            by_cleanup: ["cleanupAt", "_creationTime"];
        }, {}, {}>;
        jobs: import("convex/server").TableDefinition<import("convex/values").VObject<{
            code?: "SANDBOX_JOB_DEADLINE" | undefined;
            providerJobId?: string | undefined;
            lateAttempts?: number | undefined;
            wakeId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
            exitCode?: number | undefined;
            logTail?: string | undefined;
            state: "failed" | "running" | "done" | "unknown" | "starting";
            subject: string;
            threadId: string;
            runId: string;
            claim: string;
            leaseUntil: number;
            scopeKey: string;
            sandboxId: string;
            directory: string;
            deadline: number;
            pollMinMs: number;
            pollMaxMs: number;
            delayMs: number;
            pollHandle: string;
        }, {
            scopeKey: import("convex/values").VString<string, "required">;
            subject: import("convex/values").VString<string, "required">;
            threadId: import("convex/values").VString<string, "required">;
            runId: import("convex/values").VString<string, "required">;
            providerJobId: import("convex/values").VString<string | undefined, "optional">;
            sandboxId: import("convex/values").VString<string, "required">;
            directory: import("convex/values").VString<string, "required">;
            state: import("convex/values").VUnion<"failed" | "running" | "done" | "unknown" | "starting", [import("convex/values").VLiteral<"starting", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
            deadline: import("convex/values").VFloat64<number, "required">;
            pollMinMs: import("convex/values").VFloat64<number, "required">;
            pollMaxMs: import("convex/values").VFloat64<number, "required">;
            delayMs: import("convex/values").VFloat64<number, "required">;
            pollHandle: import("convex/values").VString<string, "required">;
            claim: import("convex/values").VString<string, "required">;
            leaseUntil: import("convex/values").VFloat64<number, "required">;
            lateAttempts: import("convex/values").VFloat64<number | undefined, "optional">;
            wakeId: import("convex/values").VId<import("convex/values").GenericId<"_scheduled_functions"> | undefined, "optional">;
            exitCode: import("convex/values").VFloat64<number | undefined, "optional">;
            logTail: import("convex/values").VString<string | undefined, "optional">;
            code: import("convex/values").VLiteral<"SANDBOX_JOB_DEADLINE" | undefined, "optional">;
        }, "required", "state" | "subject" | "threadId" | "runId" | "claim" | "leaseUntil" | "code" | "scopeKey" | "sandboxId" | "providerJobId" | "directory" | "deadline" | "pollMinMs" | "pollMaxMs" | "delayMs" | "pollHandle" | "lateAttempts" | "wakeId" | "exitCode" | "logTail">, {
            by_scope_state: ["scopeKey", "state", "_creationTime"];
        }, {}, {}>;
    }, true>;
    modules: Record<string, () => Promise<unknown>>;
};
export default _default;
export { fakeSandboxProvider } from "../../testing/sandbox.js";
