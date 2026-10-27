/**
 * Row builders and the thread lookup for the `assignments` table.
 *
 * One assignment is one native thread under agevex management: its execution
 * token, cancellation epoch, inbox counters, approval pause and recovery state.
 * Roots are created by `turns.send.accept` on a host send; children by
 * `subagents.launch.attach` when a delegation's native thread exists. Both builders
 * return the complete first row so the insert call sites stay short and every
 * counter visibly starts at its zero state.
 */
import type { WithoutSystemFields } from "convex/server";
import type { QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import type { Limits } from "../limits.js";
type AssignmentRow = WithoutSystemFields<Doc<"assignments">>;
/** The assignment owning a native thread, via the unique `by_thread` index.
 * One indexed point read (<=16 KiB); used by every thread-addressed endpoint. */
export declare function assignmentByThread(ctx: Pick<QueryCtx, "db">, threadId: string): Promise<{
    _id: import("convex/values").GenericId<"assignments">;
    _creationTime: number;
    workflowId?: string | undefined;
    activeTools?: {
        name: string;
        key: string;
    }[] | undefined;
    textConfig?: {
        worker: string;
        updateThread: string;
        getThread: string;
    } | undefined;
    models?: Record<string, string> | undefined;
    workflowTurnToken?: string | undefined;
    wakeEventId?: string | undefined;
    modelSteps?: number | undefined;
    pendingGeneration?: {
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
    runId?: import("convex/values").GenericId<"runs"> | undefined;
    childRunId?: string | undefined;
    rootAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
    turnToken?: string | undefined;
    promptMessageId?: string | undefined;
    turnReport?: {
        resumeInboxId?: import("convex/values").GenericId<"inbox"> | undefined;
        promptMessageId: string;
        messageIds: string[];
        maxMessages: number;
    } | undefined;
    turnOrigin?: "user" | "subagent_result" | undefined;
    inboxId?: import("convex/values").GenericId<"inbox"> | undefined;
    approvals?: {
        cleanupPending?: boolean | undefined;
        epoch: number;
        getMessages: string;
        inboxId: import("convex/values").GenericId<"inbox">;
        addMessages: string;
        requests: {
            deferred?: boolean | undefined;
            resolved?: true | undefined;
            effective?: boolean | undefined;
            key: string;
            messageId: string;
            proposalId: import("convex/values").GenericId<"receipts">;
            providerExecuted: boolean;
            toolCallKey: ArrayBuffer;
        }[];
    } | undefined;
    lastSlice?: {
        id?: string | undefined;
        active: boolean;
    } | undefined;
    notesPending: number;
    agent: string;
    limits: {
        attachmentBytes: number;
        notesPending: number;
        maxDepth: number;
        messagesPerChild: number;
        parentNotesPerChild: number;
        rootLane: number;
        childLane: number;
        runLaunches: number;
        runHops: number;
        activeChildrenPerRoot: number;
        taskLength: number;
        queueLength: number;
        slicesPerTurn: number;
        leaseMs: number;
    };
    turnStatus: "idle" | "running" | "queued" | "recovery_required";
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
    subject: string;
    threadId: string;
    runTurn: string;
    cancellationEpoch: number;
    cancelled: boolean;
    queuedMessages: number;
    nextSequence: number;
    nextTurn: number;
    activeRuns: number;
    nextRunSequence: number;
} | null>;
/** First row of a public root thread, created by `turns.send.accept` on its first
 * send. It carries no `childRunId`/`rootAssignmentId`: the absence of those
 * two fields is what makes it a root for its whole life. */
export declare function newRootAssignment(fields: {
    subject: string;
    agent: string;
    threadId: string;
    runTurn: string;
    limits: Limits;
}): AssignmentRow;
/** First row of a delegated child thread, created by `subagents.launch.attach` in the
 * same transaction as its first inbox row. The child inherits the root's
 * subject, host action and resolved limits, and runs under the parent's run
 * budget (`runId`), so its delegations spend the same launches and hops. Its
 * first prompt is already queued: `queuedMessages`/`nextSequence` start at 1. */
export declare function newChildAssignment(fields: {
    root: Doc<"assignments">;
    run: Doc<"subagentRuns">;
    childThreadId: string;
}): AssignmentRow;
export {};
