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
/** The current root request's delegation tree; see subagents/views.ts. */
export declare const runTree: import("convex/server").RegisteredQuery<"public", {
    subject: string;
    threadId: string;
}, Promise<{
    runId: string;
    side: boolean;
    parentAssignmentId: import("convex/values").GenericId<"assignments">;
    childAssignmentId: import("convex/values").GenericId<"assignments"> | null;
    agent: string;
    status: "failed" | "running" | "completed" | "queued" | "asking";
    depth: number;
    group: string | null;
    childThreadId: string | null;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
}[]>>;
