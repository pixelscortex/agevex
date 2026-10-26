import { type MutationCtx, type QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
export declare const interactionArgs: {
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    turnToken: import("convex/values").VString<string, "required">;
    op: import("convex/values").VUnion<"message" | "ask", [import("convex/values").VLiteral<"message", "required">, import("convex/values").VLiteral<"ask", "required">], "required", never>;
    runId: import("convex/values").VString<string | undefined, "optional">;
};
type InteractionArgs = {
    assignmentId: Doc<"assignments">["_id"];
    turnToken: string;
    op: "message" | "ask";
    runId?: string;
};
/** Constant-size admission: actor + root + target + child + shared budget.
 * No native payload is read here. All writes below rerun this check inside
 * the native-save transaction, so neither a stale turn nor root cancellation
 * can admit a question/message after its fence.
 */
export declare function interaction(ctx: QueryCtx | MutationCtx, args: InteractionArgs): Promise<{
    kind: "denied";
    code: "FORBIDDEN" | "STALE_TURN" | "RUN_BUDGET" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT";
} | {
    kind: "ready";
    actor: {
        _id: import("convex/values").GenericId<"assignments">;
        _creationTime: number;
        workflowId?: string | undefined;
        runId?: import("convex/values").GenericId<"runs"> | undefined;
        modelStep?: {
            messageId: string;
            stepOrder: number;
        } | undefined;
        contextMessages?: {
            order: number;
            bytes: number;
            id: string;
            stepOrder: number;
            sequence: number;
        }[] | undefined;
        reviewed?: {
            agent: string;
            at: number;
            turn: number;
            boundary: number;
        }[] | undefined;
        routingAgentIndex?: number | undefined;
        hookContinue?: boolean | undefined;
        models?: Record<string, string> | undefined;
        loopWaiting?: boolean | undefined;
        pinged?: boolean | undefined;
        recoveryAt?: number | undefined;
        recoveryJobId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
        recoveryDelayMs?: number | undefined;
        modelSteps?: number | undefined;
        watchdogId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
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
        } | undefined;
        childRunId?: string | undefined;
        rootAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
        turnToken?: string | undefined;
        promptMessageId?: string | undefined;
        turnOrigin?: "user" | "subagent_result" | undefined;
        inboxId?: import("convex/values").GenericId<"inbox"> | undefined;
        approvalBlocked?: boolean | undefined;
        approvals?: {
            cleanupPending?: boolean | undefined;
            epoch: number;
            getMessages: string;
            inboxId: import("convex/values").GenericId<"inbox">;
            addMessages: string;
            requests: {
                deferred?: boolean | undefined;
                resolved?: true | undefined;
                key: string;
                messageId: string;
                providerExecuted: boolean;
                toolCallKey: ArrayBuffer;
            }[];
        } | undefined;
        lastSlice?: string | undefined;
        notesPending: number;
        agent: string;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
        threadId: string;
        turnStatus: "idle" | "running" | "queued" | "recovery_required";
        queuedMessages: number;
        subject: string;
        limits: {
            attachmentBytes: number;
            continuesPerRun: number;
            sideRunsPerRun: number;
            notesPending: number;
            maxDepth: number;
            messagesPerChild: number;
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
        completedTurns: number;
        runTurn: string;
        cancellationEpoch: number;
        cancelled: boolean;
        nextSequence: number;
        nextTurn: number;
        activeRuns: number;
        nextRunSequence: number;
    };
    root: {
        _id: import("convex/values").GenericId<"assignments">;
        _creationTime: number;
        workflowId?: string | undefined;
        runId?: import("convex/values").GenericId<"runs"> | undefined;
        modelStep?: {
            messageId: string;
            stepOrder: number;
        } | undefined;
        contextMessages?: {
            order: number;
            bytes: number;
            id: string;
            stepOrder: number;
            sequence: number;
        }[] | undefined;
        reviewed?: {
            agent: string;
            at: number;
            turn: number;
            boundary: number;
        }[] | undefined;
        routingAgentIndex?: number | undefined;
        hookContinue?: boolean | undefined;
        models?: Record<string, string> | undefined;
        loopWaiting?: boolean | undefined;
        pinged?: boolean | undefined;
        recoveryAt?: number | undefined;
        recoveryJobId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
        recoveryDelayMs?: number | undefined;
        modelSteps?: number | undefined;
        watchdogId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
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
        } | undefined;
        childRunId?: string | undefined;
        rootAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
        turnToken?: string | undefined;
        promptMessageId?: string | undefined;
        turnOrigin?: "user" | "subagent_result" | undefined;
        inboxId?: import("convex/values").GenericId<"inbox"> | undefined;
        approvalBlocked?: boolean | undefined;
        approvals?: {
            cleanupPending?: boolean | undefined;
            epoch: number;
            getMessages: string;
            inboxId: import("convex/values").GenericId<"inbox">;
            addMessages: string;
            requests: {
                deferred?: boolean | undefined;
                resolved?: true | undefined;
                key: string;
                messageId: string;
                providerExecuted: boolean;
                toolCallKey: ArrayBuffer;
            }[];
        } | undefined;
        lastSlice?: string | undefined;
        notesPending: number;
        agent: string;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
        threadId: string;
        turnStatus: "idle" | "running" | "queued" | "recovery_required";
        queuedMessages: number;
        subject: string;
        limits: {
            attachmentBytes: number;
            continuesPerRun: number;
            sideRunsPerRun: number;
            notesPending: number;
            maxDepth: number;
            messagesPerChild: number;
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
        completedTurns: number;
        runTurn: string;
        cancellationEpoch: number;
        cancelled: boolean;
        nextSequence: number;
        nextTurn: number;
        activeRuns: number;
        nextRunSequence: number;
    };
    run: {
        _id: import("convex/values").GenericId<"subagentRuns">;
        _creationTime: number;
        join?: "open" | "sealed" | "ready" | "joined" | undefined;
        startedAt?: number | undefined;
        side?: boolean | undefined;
        childThreadId?: string | undefined;
        resultMessageId?: string | undefined;
        group?: string | undefined;
        questionMessageId?: string | undefined;
        childAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
        childResultMessageId?: string | undefined;
        lastTurnResult?: {
            messageId?: string | undefined;
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
        } | undefined;
        resultSequence?: number | undefined;
        events: {
            phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
            at: number;
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
        }[];
        status: "failed" | "running" | "completed" | "queued" | "asking";
        agent: string;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
        runId: string;
        deliveryStatus: "failed" | "pending" | "accepted" | "blocked";
        createdAt: number;
        sequence: number;
        rootAssignmentId: import("convex/values").GenericId<"assignments">;
        rootCancellationEpoch: number;
        parentRunId: import("convex/values").GenericId<"runs">;
        dedupKey: string;
        payloadFingerprint: string;
        actorAssignmentId: import("convex/values").GenericId<"assignments">;
        depth: number;
        messagesReceived: number;
        actorAgent: string;
        deliveryToken: string;
        coordinateHandle: string;
    };
    child: {
        _id: import("convex/values").GenericId<"assignments">;
        _creationTime: number;
        workflowId?: string | undefined;
        runId?: import("convex/values").GenericId<"runs"> | undefined;
        modelStep?: {
            messageId: string;
            stepOrder: number;
        } | undefined;
        contextMessages?: {
            order: number;
            bytes: number;
            id: string;
            stepOrder: number;
            sequence: number;
        }[] | undefined;
        reviewed?: {
            agent: string;
            at: number;
            turn: number;
            boundary: number;
        }[] | undefined;
        routingAgentIndex?: number | undefined;
        hookContinue?: boolean | undefined;
        models?: Record<string, string> | undefined;
        loopWaiting?: boolean | undefined;
        pinged?: boolean | undefined;
        recoveryAt?: number | undefined;
        recoveryJobId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
        recoveryDelayMs?: number | undefined;
        modelSteps?: number | undefined;
        watchdogId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
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
        } | undefined;
        childRunId?: string | undefined;
        rootAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
        turnToken?: string | undefined;
        promptMessageId?: string | undefined;
        turnOrigin?: "user" | "subagent_result" | undefined;
        inboxId?: import("convex/values").GenericId<"inbox"> | undefined;
        approvalBlocked?: boolean | undefined;
        approvals?: {
            cleanupPending?: boolean | undefined;
            epoch: number;
            getMessages: string;
            inboxId: import("convex/values").GenericId<"inbox">;
            addMessages: string;
            requests: {
                deferred?: boolean | undefined;
                resolved?: true | undefined;
                key: string;
                messageId: string;
                providerExecuted: boolean;
                toolCallKey: ArrayBuffer;
            }[];
        } | undefined;
        lastSlice?: string | undefined;
        notesPending: number;
        agent: string;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
        threadId: string;
        turnStatus: "idle" | "running" | "queued" | "recovery_required";
        queuedMessages: number;
        subject: string;
        limits: {
            attachmentBytes: number;
            continuesPerRun: number;
            sideRunsPerRun: number;
            notesPending: number;
            maxDepth: number;
            messagesPerChild: number;
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
        completedTurns: number;
        runTurn: string;
        cancellationEpoch: number;
        cancelled: boolean;
        nextSequence: number;
        nextTurn: number;
        activeRuns: number;
        nextRunSequence: number;
    };
    parent: {
        _id: import("convex/values").GenericId<"assignments">;
        _creationTime: number;
        workflowId?: string | undefined;
        runId?: import("convex/values").GenericId<"runs"> | undefined;
        modelStep?: {
            messageId: string;
            stepOrder: number;
        } | undefined;
        contextMessages?: {
            order: number;
            bytes: number;
            id: string;
            stepOrder: number;
            sequence: number;
        }[] | undefined;
        reviewed?: {
            agent: string;
            at: number;
            turn: number;
            boundary: number;
        }[] | undefined;
        routingAgentIndex?: number | undefined;
        hookContinue?: boolean | undefined;
        models?: Record<string, string> | undefined;
        loopWaiting?: boolean | undefined;
        pinged?: boolean | undefined;
        recoveryAt?: number | undefined;
        recoveryJobId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
        recoveryDelayMs?: number | undefined;
        modelSteps?: number | undefined;
        watchdogId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
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
        } | undefined;
        childRunId?: string | undefined;
        rootAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
        turnToken?: string | undefined;
        promptMessageId?: string | undefined;
        turnOrigin?: "user" | "subagent_result" | undefined;
        inboxId?: import("convex/values").GenericId<"inbox"> | undefined;
        approvalBlocked?: boolean | undefined;
        approvals?: {
            cleanupPending?: boolean | undefined;
            epoch: number;
            getMessages: string;
            inboxId: import("convex/values").GenericId<"inbox">;
            addMessages: string;
            requests: {
                deferred?: boolean | undefined;
                resolved?: true | undefined;
                key: string;
                messageId: string;
                providerExecuted: boolean;
                toolCallKey: ArrayBuffer;
            }[];
        } | undefined;
        lastSlice?: string | undefined;
        notesPending: number;
        agent: string;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
        threadId: string;
        turnStatus: "idle" | "running" | "queued" | "recovery_required";
        queuedMessages: number;
        subject: string;
        limits: {
            attachmentBytes: number;
            continuesPerRun: number;
            sideRunsPerRun: number;
            notesPending: number;
            maxDepth: number;
            messagesPerChild: number;
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
        completedTurns: number;
        runTurn: string;
        cancellationEpoch: number;
        cancelled: boolean;
        nextSequence: number;
        nextTurn: number;
        activeRuns: number;
        nextRunSequence: number;
    };
    budget: {
        _id: import("convex/values").GenericId<"runs">;
        _creationTime: number;
        settings?: {
            agent: string;
            settings: {
                mode: "stream" | "generate";
                maxOutputTokens: number;
                modelTimeoutMs: number;
                toolTimeoutMs: number;
                stepsPerTurn: number;
            };
        }[] | undefined;
        models?: Record<string, string> | undefined;
        usagePartial?: boolean | undefined;
        cancelled: boolean;
        startedAgents: bigint;
        routingAgents: bigint;
        continues: number;
        sideRuns: number;
        launches: number;
        hops: number;
    };
}>;
/** Enqueue an already saved native message as ready work on `target` and wake
 * it. `answering` lets a parent's reply to an open question use the one extra
 * reserved slot even when the child's ready queue is full. */
export declare function post(ctx: MutationCtx, target: Doc<"assignments">, runId: Doc<"runs">["_id"], messageId: string, kind: "parent" | "note", answering?: boolean): Promise<void>;
/** Trusted target projection for the host's atomic native message saves:
 * the threads and agents on both ends, or the admission denial. */
export declare function interactionTarget(ctx: QueryCtx, args: InteractionArgs): Promise<{
    kind: "denied";
    code: "FORBIDDEN" | "STALE_TURN" | "RUN_BUDGET" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT";
} | {
    kind: "ready";
    runId: string;
    agent: string;
    subject: string;
    childThreadId: string;
    parentThreadId: string;
    rootThreadId: string;
    rootAssignmentId: import("convex/values").GenericId<"assignments">;
    rootAgent: string;
    actorAgent: string;
    parentAgent: string;
}>;
/** `subagents.messages.messageChild`: the exact native follow-up id is saved in the
 * child's inbox in the same transaction. Answers an open question (resuming
 * the child) when the child is asking; spends one hop either way. */
export declare function sendToChild(ctx: MutationCtx, args: {
    assignmentId: Doc<"assignments">["_id"];
    turnToken: string;
    runId: string;
    messageId: string;
}): Promise<{
    status: "accepted";
    runId: string;
}>;
/** `subagents.messages.askParent`: asking holds the active slot. The question bypasses
 * result joins (otherwise a child waiting for its parent would deadlock its
 * own group). Its native assistant id and the parent's inbox id commit with
 * BOTH native saves; spends one hop. */
export declare function askParentRun(ctx: MutationCtx, args: {
    assignmentId: Doc<"assignments">["_id"];
    turnToken: string;
    questionMessageId: string;
    parentMessageId: string;
}): Promise<{
    status: "accepted";
    runId: string;
}>;
/** Trusted target projection for the host's atomic native message saves. */
export declare const interactionContext: import("convex/server").RegisteredQuery<"public", {
    runId?: string | undefined;
    assignmentId: import("convex/values").GenericId<"assignments">;
    turnToken: string;
    op: "message" | "ask";
}, Promise<{
    kind: "denied";
    code: "FORBIDDEN" | "STALE_TURN" | "RUN_BUDGET" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT";
} | {
    kind: "ready";
    runId: string;
    agent: string;
    subject: string;
    childThreadId: string;
    parentThreadId: string;
    rootThreadId: string;
    rootAssignmentId: import("convex/values").GenericId<"assignments">;
    rootAgent: string;
    actorAgent: string;
    parentAgent: string;
}>>;
/** The exact native follow-up id is saved in the inbox in the same transaction. */
export declare const messageChild: import("convex/server").RegisteredMutation<"public", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    runId: string;
    messageId: string;
    turnToken: string;
}, Promise<{
    status: "accepted";
    runId: string;
}>>;
/** A child's question to its parent; see `askParentRun`. */
export declare const askParent: import("convex/server").RegisteredMutation<"public", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    turnToken: string;
    questionMessageId: string;
    parentMessageId: string;
}, Promise<{
    status: "accepted";
    runId: string;
}>>;
/** Only a recorded open question can be authenticated; never scan history. */
export declare const questionContext: import("convex/server").RegisteredQuery<"public", {
    runId: string;
}, Promise<string | null>>;
export {};
