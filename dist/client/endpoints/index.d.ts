import type { ComponentApi } from "../../component/_generated/component.js";
import type { RuntimeContext } from "../registration/context.js";
import type { Registration } from "../types.js";
export type { OriginMessage } from "./reads.js";
/** Build every public endpoint for one registration. */
export declare function authorizedEndpoints(component: ComponentApi, config: Registration, settings: RuntimeContext["settings"]): {
    title: import("convex/server").RegisteredQuery<"public", {
        threadId: string;
    }, Promise<{
        text: string | null;
        source: "auto" | "user" | null;
        version: number;
    }>>;
    rename: import("convex/server").RegisteredMutation<"public", {
        text: string;
        threadId: string;
        expectedVersion: number;
    }, Promise<{
        messageId: string;
        replayed: boolean;
    }>>;
    summary: import("convex/server").RegisteredQuery<"public", {
        threadId: string;
    }, Promise<{
        text: string;
        throughMessageId: string;
    } | null>>;
    summarize: import("convex/server").RegisteredMutation<"public", {
        threadId: string;
        requestKey: string;
    }, Promise<{
        status: "replayed";
    } | {
        status: "queued";
    }>>;
    open: import("convex/server").RegisteredMutation<"public", {
        models?: Record<string, string> | undefined;
        files?: string[] | undefined;
        agent: string;
        requestKey: string;
        prompt: string;
    }, Promise<{
        status: "rejected";
        code: "INVALID_MESSAGE" | "INVALID_REQUEST_KEY";
    } | {
        status: "rejected";
        code: "UNKNOWN_AGENT";
    } | {
        status: "rejected";
        code: "INVALID_MODELS";
    } | {
        status: "rejected";
        code: "KEY_CONFLICT";
    } | {
        receiptId: string;
        status: "duplicate";
        assignmentId: string;
        threadId: string;
        position: number;
        code?: undefined;
    } | {
        assignmentId: string;
        threadId: string;
        receiptId: string;
        status: "accepted";
        position: number;
    } | {
        status: "rejected";
        code: "ATTACHMENT_LIMIT";
    }>>;
    send: import("convex/server").RegisteredMutation<"public", {
        models?: Record<string, string> | undefined;
        files?: string[] | undefined;
        text: string;
        threadId: string;
        requestKey: string;
    }, Promise<{
        status: "rejected";
        code: "INVALID_MESSAGE" | "INVALID_REQUEST_KEY";
    } | {
        status: "rejected";
        code: "UNKNOWN_AGENT";
    } | {
        status: "rejected";
        code: "INVALID_MODELS";
    } | {
        status: "rejected";
        code: "KEY_CONFLICT";
    } | {
        receiptId: string;
        status: "duplicate";
        assignmentId: string;
        threadId: string;
        position: number;
        code?: undefined;
    } | {
        assignmentId: string;
        threadId: string;
        receiptId: string;
        status: "accepted";
        position: number;
    } | {
        status: "rejected";
        code: "CANCELLED" | "RECOVERY_REQUIRED";
    } | {
        status: "rejected";
        code: "QUEUE_FULL";
    } | {
        status: "rejected";
        code: "ATTACHMENT_LIMIT";
    }>>;
    respond: import("convex/server").RegisteredMutation<"public", {
        threadId: string;
        approvalId: string;
        decision: {
            reason?: string | undefined;
            kind: "reject";
        } | {
            edit?: {
                input: any;
            } | undefined;
            kind: "approve";
        };
    }, Promise<{
        messageId: string;
        replayed: boolean;
    }>>;
    pendingApprovals: import("convex/server").RegisteredQuery<"public", {
        rootRunId?: string | undefined;
        threadId: string;
    }, Promise<{
        schema?: any;
        question?: string | undefined;
        editable: boolean;
        threadId: string;
        agent: string;
        kind: "ask" | "approval";
        truncated?: true | undefined;
        id: string;
        providerExecuted: boolean;
        toolCallId: string;
        tool: string;
        input: any;
    }[]>>;
    answer: import("convex/server").RegisteredMutation<"public", {
        value: any;
        threadId: string;
        toolCallId: string;
    }, Promise<{
        messageId: string;
        replayed: boolean;
    }>>;
    cancel: import("convex/server").RegisteredMutation<"public", {
        threadId: string;
    }, Promise<null>>;
    messages: import("convex/server").RegisteredQuery<"public", {
        paginationOpts: {
            id?: number;
            endCursor?: string | null;
            maximumRowsRead?: number;
            maximumBytesRead?: number;
            numItems: number;
            cursor: string | null;
        };
        threadId: string;
    }, Promise<import("convex/server").PaginationResult<import("./reads.js").OriginMessage>>>;
    streams: import("convex/server").RegisteredQuery<"public", {
        streamArgs?: {
            startOrder?: number | undefined;
            kind: "list";
        } | {
            kind: "deltas";
            cursors: {
                streamId: string;
                cursor: number;
            }[];
        } | undefined;
        threadId: string;
    }, Promise<{
        streams: import("@convex-dev/agent").SyncStreamsReturnValue;
    }>>;
    activity: import("convex/server").RegisteredQuery<"public", {
        threadId: string;
    }, Promise<{
        assignmentId: string;
        threadId: string;
        agent: string;
        assignmentStatus: "open";
        turnStatus: "idle" | "running" | "queued" | "recovery_required";
        queuedMessages: number;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
        runId: string | undefined;
        subagents: {
            active: number;
            history: number;
            total: number;
        };
    }>>;
    runTree: import("convex/server").RegisteredQuery<"public", {
        threadId: string;
    }, Promise<{
        runId: string;
        side: boolean;
        parentAssignmentId: string;
        childAssignmentId: string | null;
        agent: string;
        status: "failed" | "running" | "completed" | "queued" | "asking";
        depth: number;
        group: string | null;
        childThreadId: string | null;
        createdAt: number;
        startedAt: number | null;
        finishedAt: number | null;
    }[]>>;
    delegations: import("convex/server").RegisteredQuery<"public", {
        paginationOpts: {
            id?: number;
            endCursor?: string | null;
            maximumRowsRead?: number;
            maximumBytesRead?: number;
            numItems: number;
            cursor: string | null;
        };
        threadId: string;
    }, Promise<{
        page: {
            resultMessageId: string | null;
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            events: {
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
                at: number;
                phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
                runId: string;
                agent: string;
            }[];
            finishedAt: number | null;
            deliveryAt: number | null;
            runId: string;
            side: boolean;
            childThreadId: string | null;
            agent: string;
            status: "failed" | "running" | "completed" | "queued" | "asking";
            deliveryStatus: "failed" | "pending" | "accepted" | "blocked";
            createdAt: number;
            startedAt: number | null;
        }[];
        isDone: boolean;
        continueCursor: string;
    }>>;
};
