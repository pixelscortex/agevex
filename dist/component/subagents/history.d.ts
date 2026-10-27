/** The root thread's delegation history, newest first. */
export declare const delegations: import("convex/server").RegisteredQuery<"public", {
    paginationOpts: {
        id?: number;
        endCursor?: string | null;
        maximumRowsRead?: number;
        maximumBytesRead?: number;
        numItems: number;
        cursor: string | null;
    };
    subject: string;
    threadId: string;
}, Promise<{
    page: {
        resultMessageId: string | null;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
        events: {
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
            phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
            at: number;
            runId: import("convex/values").GenericId<"subagentRuns">;
            agent: string;
        }[];
        finishedAt: number | null;
        deliveryAt: number | null;
        runId: import("convex/values").GenericId<"subagentRuns">;
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
/** The current root request's delegation tree; see subagents/views.ts. */
export declare const runTree: import("convex/server").RegisteredQuery<"public", {
    rootRunId?: string | undefined;
    subject: string;
    threadId: string;
}, Promise<{
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
} | null>>;
