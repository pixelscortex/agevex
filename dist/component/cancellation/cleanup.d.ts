import { type MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { pendingGeneration } from "../schema.js";
type PendingGeneration = typeof pendingGeneration.type;
type Approvals = NonNullable<Doc<"assignments">["approvals"]>;
/** Exactly one recorded placeholder per transaction, including native payload reads. */
export declare function finalize(ctx: MutationCtx, pending: PendingGeneration): Promise<void>;
/** Abort the execution's tracked stream (if any), then fail its placeholder. */
export declare function failPendingGeneration(ctx: MutationCtx, pending: PendingGeneration): Promise<void>;
/** Close the first recorded request natively: an "execution-denied" result
 * for its call and, for an undecided approval, a denial response. */
export declare function denyFirstRequest(ctx: MutationCtx, row: Doc<"assignments">, approvals: Approvals): Promise<void>;
/** Drop the handled request; chain the next cleanup job, or release the
 * pause and wake the assignment when none remain: a send accepted after the
 * cancel may have queued work that the pause was holding back. */
export declare function continueOrRelease(ctx: MutationCtx, row: Doc<"assignments">, approvals: Approvals, approvalEpoch: number | undefined): Promise<void>;
/** Run one cleanup step as a nested savepoint; on failure, park the
 * assignment with CLEANUP_FAILED if this job still owns the cleanup. */
export declare const cleanup: import("convex/server").RegisteredMutation<"internal", {
    pending?: {
        stream?: {
            id: string;
            abort: string;
        } | undefined;
        epoch: number;
        messageId: string;
        executionId: string;
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
        epoch: number;
        messageId: string;
        executionId: string;
        getMessages: string;
        finalizeMessage: string;
    } | undefined;
    approvalEpoch?: number | undefined;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
/** The only stale write allowed: close this execution/epoch's own placeholder. */
export declare const close: import("convex/server").RegisteredMutation<"internal", {
    epoch: number;
    assignmentId: import("convex/values").GenericId<"assignments">;
    messageId: string;
    executionId: string;
}, Promise<null>>;
export {};
