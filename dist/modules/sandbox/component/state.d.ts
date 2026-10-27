/**
 * Stable registered API for sandbox lifecycle and background-job metadata.
 * Admission and shared transitions live in helper modules; API paths remain state.*.
 * All reads are bounded or exact-id lookups; claims fence stale lifecycle and poll actions.
 */
/** Read the unique bounded scope binding for host lifecycle decisions. */
export declare const get: import("convex/server").RegisteredQuery<"public", {
    scopeKey: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sandboxes">;
    _creationTime: number;
    sandboxId?: string | undefined;
    cleanupAt?: number | undefined;
    state: "stopped" | "unknown" | "ready" | "creating" | "deleting" | "deleted";
    claim: string;
    leaseUntil: number;
    provider: string;
    scopeKey: string;
    lastUsedAt: number;
    ttl: number;
} | null>>;
/** Admission is transactional: a lost create result cannot authorize another create. */
export declare const reserve: import("convex/server").RegisteredMutation<"public", {
    scopeKey: string;
    provider: string;
    ttl: number;
    existingOnly?: boolean;
}, Promise<{
    status: "claimed";
    claim: `${string}-${string}-${string}-${string}-${string}`;
    sandboxId?: undefined;
} | {
    status: "running" | "unknown";
    claim?: undefined;
    sandboxId?: undefined;
} | {
    status: "existing";
    sandboxId: string;
    claim: string;
}>>;
/**
 * Drop a reservation whose create outcome was lost (no provider id, unknown or
 * its lease expired). Never touches a row that has a sandboxId, so it cannot
 * orphan a known paid resource. The host first looks the lost sandbox up at
 * the provider (Daytona: label agevexScope / userKey = this scopeKey).
 */
export declare const forget: import("convex/server").RegisteredMutation<"public", {
    scopeKey: string;
}, Promise<boolean>>;
/** Save identity before readiness; stale lifecycle actions cannot revive a deleted row. */
export declare const save: import("convex/server").RegisteredMutation<"public", {
    sandboxId?: string | undefined;
    state: "stopped" | "unknown" | "ready" | "creating" | "deleted";
    claim: string;
    scopeKey: string;
}, Promise<boolean>>;
/** Host cleanup is explicitly invoked; this query does not arm any recurring timer. */
export declare const expired: import("convex/server").RegisteredQuery<"public", {
    limit: number;
}, Promise<{
    _id: import("convex/values").GenericId<"sandboxes">;
    _creationTime: number;
    sandboxId?: string | undefined;
    cleanupAt?: number | undefined;
    state: "stopped" | "unknown" | "ready" | "creating" | "deleting" | "deleted";
    claim: string;
    leaseUntil: number;
    provider: string;
    scopeKey: string;
    lastUsedAt: number;
    ttl: number;
}[]>>;
/** Recheck expiry atomically with delete admission to close the idle/use race. */
export declare const claimDelete: import("convex/server").RegisteredMutation<"public", {
    scopeKey: string;
    expiredOnly: boolean;
}, Promise<{
    sandboxId: string;
    claim: `${string}-${string}-${string}-${string}-${string}`;
} | null>>;
/** Reserve one bounded active job and persist its launch watchdog atomically. */
export declare const reserveJob: import("convex/server").RegisteredMutation<"public", {
    scopeKey: string;
    subject: string;
    threadId: string;
    runId: string;
    pollHandle: string;
    pollMinMs: number;
    pollMaxMs: number;
    jobTimeoutMs: number;
    maximum: number;
}, Promise<{
    jobId: import("convex/values").GenericId<"jobs">;
    claim: `${string}-${string}-${string}-${string}-${string}`;
    providerJobId: `${string}-${string}-${string}-${string}-${string}`;
    sandboxId: string;
    directory: string;
}>>;
/** Attach a launch acknowledgement only while its original claim still owns the job. */
export declare const attachJob: import("convex/server").RegisteredMutation<"public", {
    claim: string;
    providerJobId: string;
    jobId: import("convex/values").GenericId<"jobs">;
}, Promise<boolean>>;
/** Read one job by exact id for polling and host reconciliation. */
export declare const getJob: import("convex/server").RegisteredQuery<"public", {
    jobId: import("convex/values").GenericId<"jobs">;
}, Promise<{
    _id: import("convex/values").GenericId<"jobs">;
    _creationTime: number;
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
} | null>>;
/** Polls only read provider state, but a lease still fences overlapping watchdogs. */
export declare const claimPoll: import("convex/server").RegisteredMutation<"public", {
    jobId: import("convex/values").GenericId<"jobs">;
}, Promise<{
    claim: `${string}-${string}-${string}-${string}-${string}`;
    _id: import("convex/values").GenericId<"jobs">;
    _creationTime: number;
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
    leaseUntil: number;
    scopeKey: string;
    sandboxId: string;
    directory: string;
    deadline: number;
    pollMinMs: number;
    pollMaxMs: number;
    delayMs: number;
    pollHandle: string;
} | null>>;
/** Release the matching poll claim into bounded backoff without relaunching work. */
export declare const again: import("convex/server").RegisteredMutation<"public", {
    claim: string;
    jobId: import("convex/values").GenericId<"jobs">;
}, Promise<null>>;
/** Called inside the host settlement mutation so callback/event and state are atomic. */
export declare const finishJob: import("convex/server").RegisteredMutation<"public", {
    code?: "SANDBOX_JOB_DEADLINE" | undefined;
    exitCode?: number | undefined;
    logTail?: string | undefined;
    state: "failed" | "done" | "unknown";
    claim: string;
    jobId: import("convex/values").GenericId<"jobs">;
}, Promise<{
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
} | null>>;
