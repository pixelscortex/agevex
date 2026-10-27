export declare const sandboxDocument: import("convex/values").VObject<{
    sandboxId?: string | undefined;
    cleanupAt?: number | undefined;
    _id: import("convex/values").GenericId<"sandboxes">;
    _creationTime: number;
    state: "stopped" | "unknown" | "ready" | "creating" | "deleting" | "deleted";
    claim: string;
    leaseUntil: number;
    provider: string;
    scopeKey: string;
    idleExpiresAt: number;
}, {
    _id: import("convex/values").VId<import("convex/values").GenericId<"sandboxes">, "required">;
    _creationTime: import("convex/values").VFloat64<number, "required">;
    scopeKey: import("convex/values").VString<string, "required">;
    provider: import("convex/values").VString<string, "required">;
    sandboxId: import("convex/values").VString<string | undefined, "optional">;
    state: import("convex/values").VUnion<"stopped" | "unknown" | "ready" | "creating" | "deleting" | "deleted", [import("convex/values").VLiteral<"creating", "required">, import("convex/values").VLiteral<"ready", "required">, import("convex/values").VLiteral<"stopped", "required">, import("convex/values").VLiteral<"unknown", "required">, import("convex/values").VLiteral<"deleting", "required">, import("convex/values").VLiteral<"deleted", "required">], "required", never>;
    idleExpiresAt: import("convex/values").VFloat64<number, "required">;
    claim: import("convex/values").VString<string, "required">;
    leaseUntil: import("convex/values").VFloat64<number, "required">;
    cleanupAt: import("convex/values").VFloat64<number | undefined, "optional">;
}, "required", "_id" | "_creationTime" | "state" | "claim" | "leaseUntil" | "provider" | "scopeKey" | "sandboxId" | "idleExpiresAt" | "cleanupAt">;
export declare const jobDocument: import("convex/values").VObject<{
    code?: "SANDBOX_JOB_DEADLINE" | undefined;
    providerJobId?: string | undefined;
    lateAttempts?: number | undefined;
    wakeId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
    exitCode?: number | undefined;
    logTail?: string | undefined;
    _id: import("convex/values").GenericId<"jobs">;
    _creationTime: number;
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
    _id: import("convex/values").VId<import("convex/values").GenericId<"jobs">, "required">;
    _creationTime: import("convex/values").VFloat64<number, "required">;
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
}, "required", "_id" | "_creationTime" | "state" | "subject" | "threadId" | "runId" | "claim" | "leaseUntil" | "code" | "scopeKey" | "sandboxId" | "providerJobId" | "directory" | "deadline" | "pollMinMs" | "pollMaxMs" | "delayMs" | "pollHandle" | "lateAttempts" | "wakeId" | "exitCode" | "logTail">;
export declare const reservation: import("convex/values").VUnion<{
    status: "claimed";
    claim: string;
} | {
    status: "running" | "unknown";
} | {
    status: "existing";
    claim: string;
    sandboxId: string;
}, [import("convex/values").VObject<{
    status: "claimed";
    claim: string;
}, {
    status: import("convex/values").VLiteral<"claimed", "required">;
    claim: import("convex/values").VString<string, "required">;
}, "required", "status" | "claim">, import("convex/values").VObject<{
    status: "running" | "unknown";
}, {
    status: import("convex/values").VUnion<"running" | "unknown", [import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
}, "required", "status">, import("convex/values").VObject<{
    status: "existing";
    claim: string;
    sandboxId: string;
}, {
    status: import("convex/values").VLiteral<"existing", "required">;
    sandboxId: import("convex/values").VString<string, "required">;
    claim: import("convex/values").VString<string, "required">;
}, "required", "status" | "claim" | "sandboxId">], "required", "status" | "claim" | "sandboxId">;
export declare const jobReservation: import("convex/values").VObject<{
    providerJobId?: string | undefined;
    claim: string;
    sandboxId: string;
    directory: string;
    jobId: import("convex/values").GenericId<"jobs">;
}, {
    jobId: import("convex/values").VId<import("convex/values").GenericId<"jobs">, "required">;
    claim: import("convex/values").VString<string, "required">;
    providerJobId: import("convex/values").VString<string | undefined, "optional">;
    sandboxId: import("convex/values").VString<string, "required">;
    directory: import("convex/values").VString<string, "required">;
}, "required", "claim" | "sandboxId" | "providerJobId" | "directory" | "jobId">;
export declare const jobCompletion: import("convex/values").VObject<{
    code?: "SANDBOX_JOB_DEADLINE" | undefined;
    providerJobId?: string | undefined;
    exitCode?: number | undefined;
    logTail?: string | undefined;
    type: "sandbox.job.completed";
    state: "failed" | "done" | "unknown";
    subject: string;
    threadId: string;
    runId: string;
    scopeKey: string;
    jobId: import("convex/values").GenericId<"jobs">;
}, {
    type: import("convex/values").VLiteral<"sandbox.job.completed", "required">;
    jobId: import("convex/values").VId<import("convex/values").GenericId<"jobs">, "required">;
    providerJobId: import("convex/values").VString<string | undefined, "optional">;
    scopeKey: import("convex/values").VString<string, "required">;
    subject: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    runId: import("convex/values").VString<string, "required">;
    state: import("convex/values").VUnion<"failed" | "done" | "unknown", [import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
    exitCode: import("convex/values").VFloat64<number | undefined, "optional">;
    logTail: import("convex/values").VString<string | undefined, "optional">;
    code: import("convex/values").VLiteral<"SANDBOX_JOB_DEADLINE" | undefined, "optional">;
}, "required", "type" | "state" | "subject" | "threadId" | "runId" | "code" | "scopeKey" | "providerJobId" | "exitCode" | "logTail" | "jobId">;
