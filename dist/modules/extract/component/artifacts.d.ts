import type { Id } from "./_generated/dataModel.js";
/**
 * Constant transaction budget at every configured ceiling: identity lookup <= 1
 * artifact (< 4 KiB), insert/patch <= 1 artifact (< 4 KiB), plus a single native
 * Workflow start (small id-only args). No document grows with file/payload
 * bytes, page count, or the number of prior extractions.
 *
 * Decision (spec 5.3: reuse | wait | run(attempt + 1)):
 * - no row: insert attempt 1 and run;
 * - pending within its queue deadline, or running within its lease: wait;
 * - pending past its queue deadline: no paid work can have happened (`start`
 *   moves it to running transactionally), so dispatch it again under a new
 *   claim, same attempt; the stale dispatch can no longer start;
 * - running past its lease: unknown, reused, never rerun (paid outcome unknown);
 * - failed with a retryable code and attempts left: attempt + 1, run. This is
 *   always an explicit caller admission, never automatic, and bounded by
 *   LIMITS.maxAttempts;
 * - anything else (ready, final failure, unknown, released): reuse.
 */
export declare const admit: import("convex/server").RegisteredMutation<"public", {
    fileId: string;
    backend: string;
    version: string;
    optionsHash: string;
    worker: string;
    threadId: string;
    subject?: string;
    onComplete?: string;
}, Promise<{
    artifactId: Id<"artifacts">;
    action: "run" | "wait" | "reuse";
    callback?: "stored" | "dropped";
}>>;
/**
 * Record a terminal failure for an identity that can never be dispatched (no
 * backend accepts the file). No workflow, no lease, no provider call: just the
 * receipt, so reads return the typed error and the identity is reused instead
 * of failing the caller. Budget: one indexed lookup and at most one insert,
 * both < 4 KiB.
 */
export declare const reject: import("convex/server").RegisteredMutation<"public", {
    fileId: string;
    version: string;
    failure: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED";
    backend: string;
    optionsHash: string;
}, Promise<Id<"artifacts">>>;
/** Read one exact artifact for authorized host wrappers; no transcript lookup is needed. */
export declare const get: import("convex/server").RegisteredQuery<"public", {
    artifactId: import("convex/values").GenericId<"artifacts">;
}, Promise<{
    _id: import("convex/values").GenericId<"artifacts">;
    _creationTime: number;
    usage?: {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        credits?: number | undefined;
    } | undefined;
    failure?: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED" | undefined;
    summary?: {
        language?: string | undefined;
        kind: "document" | "text" | "image";
        textBytes: number;
        pages: number;
        preview: string;
    } | undefined;
    payloadStorageId?: string | undefined;
    callbacks?: string[] | undefined;
    status: "failed" | "running" | "pending" | "unknown" | "ready" | "released";
    claim: string;
    leaseUntil: number;
    fileId: string;
    version: string;
    backend: string;
    attempt: number;
    optionsHash: string;
} | null>>;
/** Look up one extraction identity through its unique bounded index. */
export declare const lookup: import("convex/server").RegisteredQuery<"public", {
    fileId: string;
    version: string;
    backend: string;
    optionsHash: string;
}, Promise<{
    _id: import("convex/values").GenericId<"artifacts">;
    _creationTime: number;
    usage?: {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        credits?: number | undefined;
    } | undefined;
    failure?: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED" | undefined;
    summary?: {
        language?: string | undefined;
        kind: "document" | "text" | "image";
        textBytes: number;
        pages: number;
        preview: string;
    } | undefined;
    payloadStorageId?: string | undefined;
    callbacks?: string[] | undefined;
    status: "failed" | "running" | "pending" | "unknown" | "ready" | "released";
    claim: string;
    leaseUntil: number;
    fileId: string;
    version: string;
    backend: string;
    attempt: number;
    optionsHash: string;
} | null>>;
/**
 * Claim the dispatch itself: even replay of a host action cannot repeat paid
 * work. The running lease starts here, not at admission: a job that waited in
 * the Workflow/Workpool queue has not spent anything and must not expire
 * before it begins. A stale dispatch (older claim) fails the fence.
 */
export declare const start: import("convex/server").RegisteredMutation<"public", {
    claim: string;
    attempt: number;
    artifactId: import("convex/values").GenericId<"artifacts">;
}, Promise<boolean>>;
/** Publish only the active running claim while retaining paid usage after expiry or purge. */
export declare const complete: import("convex/server").RegisteredMutation<"public", {
    unknown?: boolean | undefined;
    usage?: {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        credits?: number | undefined;
    } | undefined;
    failure?: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED" | undefined;
    summary?: {
        language?: string | undefined;
        kind: "document" | "text" | "image";
        textBytes: number;
        pages: number;
        preview: string;
    } | undefined;
    payloadStorageId?: string | undefined;
    claim: string;
    attempt: number;
    artifactId: import("convex/values").GenericId<"artifacts">;
}, Promise<boolean>>;
/**
 * Host-only storage cleanup for one native file: tombstone every extraction of
 * `fileId` (the permanent no-repeat receipt stays) and return their payload
 * storage ids for the host to delete. Admin operation: the artifact is shared by
 * every thread that attached the same bytes, so this affects all of them.
 * Components cannot `paginate`, so the walk is a creation-time cursor over the
 * `by_file` index: `after` is the first unprocessed row's creation time
 * (inclusive, so ties cannot be skipped; released rows are no-ops).
 * Budget: at most LIMITS.purgeBatch (32) artifacts patched and 33 read per call,
 * each < 4 KiB: < 132 KiB read, < 128 KiB written, 33 and 32 documents.
 */
export declare const purge: import("convex/server").RegisteredMutation<"public", {
    fileId: string;
    after: number;
}, Promise<{
    storageIds: string[];
    artifactIds: import("convex/values").GenericId<"artifacts">[];
    next: number | null;
}>>;
/**
 * Workflow completion. Only a started attempt can have an unknown paid outcome;
 * a queued row never began, so it stays pending and a later admission may
 * dispatch it again after its queue deadline.
 */
export declare const abandon: import("convex/server").RegisteredMutation<"internal", {
    claim: string;
    attempt: number;
    artifactId: string;
}, Promise<{
    owned: boolean;
    callbacks: string[];
}>>;
/** Mark only the owning expired running attempt unknown; never dispatch more paid work. */
export declare const expire: import("convex/server").RegisteredMutation<"internal", {
    claim: string;
    attempt: number;
    artifactId: import("convex/values").GenericId<"artifacts">;
}, Promise<null>>;
