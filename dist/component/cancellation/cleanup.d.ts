/** Run one cleanup step as a nested savepoint; on failure, park the
 * assignment with CLEANUP_FAILED if this job still owns the cleanup. */
export declare const cleanup: import("convex/server").RegisteredMutation<"internal", {
    pending?: {
        stream?: {
            id: string;
            abort: string;
        } | undefined;
        messageId: string;
        executionId: string;
        epoch: number;
        getMessages: string;
        finalizeMessage: string;
    } | undefined;
    approvalEpoch?: number | undefined;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
/** One cleanup step: the pending generation (if any), then the first
 * remaining recorded request of the cancelled pause. */
export declare const cleanupBatch: import("convex/server").RegisteredMutation<"internal", {
    pending?: {
        stream?: {
            id: string;
            abort: string;
        } | undefined;
        messageId: string;
        executionId: string;
        epoch: number;
        getMessages: string;
        finalizeMessage: string;
    } | undefined;
    approvalEpoch?: number | undefined;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
/** The only stale write allowed: close this execution/epoch's own placeholder. */
export declare const close: import("convex/server").RegisteredMutation<"internal", {
    messageId: string;
    executionId: string;
    epoch: number;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
