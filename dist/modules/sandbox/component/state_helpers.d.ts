import { type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { type Doc } from "./_generated/dataModel.js";
/** Unique indexed lookup; writers cap each row below sandboxRowBytes. */
export declare function sandbox(ctx: Pick<QueryCtx, "db">, scopeKey: string): Promise<{
    _id: import("convex/values").GenericId<"sandboxes">;
    _creationTime: number;
    sandboxId?: string | undefined;
    cleanupAt?: number | undefined;
    state: "stopped" | "unknown" | "ready" | "creating" | "deleting" | "deleted";
    claim: string;
    leaseUntil: number;
    provider: string;
    scopeKey: string;
    idleExpiresAt: number;
} | null>;
/** Reject oversized metadata before inserting or terminating a row. */
export declare function checkSize(value: unknown, maximum: number): void;
/** At most two tiny active-job probes, independent of retained terminal history. */
export declare function hasJobs(ctx: Pick<QueryCtx, "db">, scopeKey: string): Promise<boolean>;
/** Cancel only pending wakes: canceling an in-progress action cancels its descendants. */
export declare function cancelWake(ctx: MutationCtx, row: Pick<Doc<"jobs">, "wakeId">): Promise<void>;
/** Terminal transition shared by settlement and the watchdog's direct finish. */
export declare function terminate(ctx: MutationCtx, row: Doc<"jobs">, result: {
    state: "done" | "failed" | "unknown";
    exitCode?: number;
    logTail?: string;
    code?: "SANDBOX_JOB_DEADLINE";
}): Promise<{
    state: "done" | "failed" | "unknown";
    exitCode?: number;
    logTail?: string;
    code?: "SANDBOX_JOB_DEADLINE";
    scopeKey: string;
    subject: string;
    threadId: string;
    runId: string;
    providerJobId?: string | undefined;
    type: "sandbox.job.completed";
    jobId: import("convex/values").GenericId<"jobs">;
}>;
