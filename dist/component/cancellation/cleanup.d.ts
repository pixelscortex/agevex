import { type MutationCtx } from "../_generated/server.js";
import { pendingGeneration } from "../schema.js";
type PendingGeneration = typeof pendingGeneration.type;
/** Abort the execution's tracked stream (if any), then fail its placeholder. */
export declare function failPendingGeneration(ctx: MutationCtx, pending: PendingGeneration): Promise<void>;
/** Crash cleanup needs no recovered output: avoid finalizeMessage's native
 * delta materialization and six merge heads. Only the exact placeholder is
 * read and patched (<=4 MiB including native patch/return reads), regardless of the
 * transcript or stream backlog. The enclosing mutation owns token/epoch fences.
 */
export declare function failCrashedGeneration(ctx: MutationCtx, pending: PendingGeneration): Promise<void>;
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
        failMessage: string;
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
        failMessage: string;
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
export {};
