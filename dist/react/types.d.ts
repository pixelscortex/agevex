import type { ApiFromModules } from "convex/server";
import type { authorizedEndpoints } from "../client/endpoints/index.js";
export type QueryState<T> = {
    status: "skipped" | "loading" | "ready";
    data?: T;
};
type Endpoints = ReturnType<typeof authorizedEndpoints>;
export type AgevexApi = Partial<ApiFromModules<{
    endpoints: Endpoints;
}>["endpoints"]>;
/** Fail at the hook that needs an omitted endpoint, rather than at factory creation. */
export declare function required<K extends keyof AgevexApi>(api: AgevexApi, key: K): NonNullable<Partial<{
    title: import("convex/server").FunctionReference<"query", "public", {
        threadId: string;
    }, {
        text: string | null;
    }, string | undefined>;
    rename: import("convex/server").FunctionReference<"mutation", "public", {
        threadId: string;
        text: string;
    }, {
        messageId: string;
        replayed: boolean;
    }, string | undefined>;
    open: import("convex/server").FunctionReference<"mutation", "public", {
        models?: Record<string, string> | undefined;
        files?: string[] | undefined;
        agent: string;
        requestKey: string;
        prompt: string;
    }, {
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
    }, string | undefined>;
    send: import("convex/server").FunctionReference<"mutation", "public", {
        models?: Record<string, string> | undefined;
        files?: string[] | undefined;
        threadId: string;
        text: string;
        requestKey: string;
    }, {
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
    }, string | undefined>;
    respond: import("convex/server").FunctionReference<"mutation", "public", {
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
    }, {
        messageId: string;
        replayed: boolean;
    }, string | undefined>;
    pendingApprovals: import("convex/server").FunctionReference<"query", "public", {
        rootRunId?: string | undefined;
        threadId: string;
    }, {
        schema?: any;
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
    }[], string | undefined>;
    answer: import("convex/server").FunctionReference<"mutation", "public", {
        value: any;
        threadId: string;
        toolCallId: string;
    }, {
        messageId: string;
        replayed: boolean;
    }, string | undefined>;
    cancel: import("convex/server").FunctionReference<"mutation", "public", {
        threadId: string;
    }, null, string | undefined>;
    messages: import("convex/server").FunctionReference<"query", "public", {
        paginationOpts: {
            id?: number;
            endCursor?: string | null;
            maximumRowsRead?: number;
            maximumBytesRead?: number;
            numItems: number;
            cursor: string | null;
        };
        threadId: string;
    }, import("convex/server").PaginationResult<import("../client/endpoints/reads.js").OriginMessage>, string | undefined>;
    streams: import("convex/server").FunctionReference<"query", "public", {
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
    }, {
        streams: import("@convex-dev/agent").SyncStreamsReturnValue;
    }, string | undefined>;
    activity: import("convex/server").FunctionReference<"query", "public", {
        threadId: string;
    }, {
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
    }, string | undefined>;
    runTree: import("convex/server").FunctionReference<"query", "public", {
        rootRunId?: string | undefined;
        threadId: string;
    }, {
        usage: {
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        } | null;
        rootRunId: string;
        nodes: {
            error?: string | undefined;
            reason?: "cancelled" | "ask" | "children" | "approval" | "budget" | "recovery" | undefined;
            id: string;
            startedAt: number | null;
            status: "failed" | "running" | "queued" | "done" | "asleep";
            agent: string;
            finishedAt: number | null;
            messages: {
                taskId?: string | undefined;
                resultId?: string | undefined;
                parentResultId?: string | undefined;
                questionId?: string | undefined;
                threadId: string;
            };
            usage: {
                unknown: number;
                inputTokens: number | null;
                outputTokens: number | null;
                estimatedUsd: number;
                settledUsd: number;
                reporting: "partial" | "available";
            } | null;
            createdAt: number;
            parentId: string | null;
            currentTool: string | null;
        }[];
    } | null, string | undefined>;
    delegations: import("convex/server").FunctionReference<"query", "public", {
        paginationOpts: {
            id?: number;
            endCursor?: string | null;
            maximumRowsRead?: number;
            maximumBytesRead?: number;
            numItems: number;
            cursor: string | null;
        };
        threadId: string;
    }, {
        page: {
            resultMessageId: string | null;
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
            events: {
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
                phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
                at: number;
                runId: string;
                agent: string;
            }[];
            finishedAt: number | null;
            deliveryAt: number | null;
            runId: string;
            childThreadId: string | null;
            agent: string;
            status: "failed" | "running" | "completed" | "queued" | "asking";
            deliveryStatus: "failed" | "pending" | "accepted" | "blocked";
            createdAt: number;
            startedAt: number | null;
        }[];
        isDone: boolean;
        continueCursor: string;
    }, string | undefined>;
}>[K]>;
/** Missing input always wins over cached data, including a previously selected thread. */
export declare function queryState<T>(threadId: string | undefined, data: T | undefined): QueryState<T>;
export declare function threadRequired(threadId: string | undefined): string;
export {};
