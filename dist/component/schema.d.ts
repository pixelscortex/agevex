import { type Validator } from "convex/values";
export declare const turnOrigin: import("convex/values").VUnion<"user" | "subagent_result", [import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"subagent_result", "required">], "required", never>;
export declare const turnStatus: import("convex/values").VUnion<"idle" | "running" | "queued" | "recovery_required", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"idle", "required">, import("convex/values").VLiteral<"recovery_required", "required">], "required", never>;
export declare const errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">], "required", never>;
export declare const runErrorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
export declare const denialCode: import("convex/values").VUnion<"HOOK_BLOCKED" | "ACTIVE_LIMIT" | "TASK_LIMIT" | "FORBIDDEN" | "STALE_TURN" | "DELEGATION_CONFLICT" | "RUN_BUDGET" | "DEPTH_LIMIT" | "GROUP_LIMIT" | "GROUP_CLOSED" | "GROUP_CONFLICT" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT", [import("convex/values").VLiteral<"HOOK_BLOCKED", "required">, import("convex/values").VLiteral<"ACTIVE_LIMIT", "required">, import("convex/values").VLiteral<"TASK_LIMIT", "required">, import("convex/values").VLiteral<"FORBIDDEN", "required">, import("convex/values").VLiteral<"STALE_TURN", "required">, import("convex/values").VLiteral<"DELEGATION_CONFLICT", "required">, import("convex/values").VLiteral<"RUN_BUDGET", "required">, import("convex/values").VLiteral<"DEPTH_LIMIT", "required">, import("convex/values").VLiteral<"GROUP_LIMIT", "required">, import("convex/values").VLiteral<"GROUP_CLOSED", "required">, import("convex/values").VLiteral<"GROUP_CONFLICT", "required">, import("convex/values").VLiteral<"CHILD_FINISHED", "required">, import("convex/values").VLiteral<"MESSAGE_LIMIT", "required">, import("convex/values").VLiteral<"ASK_PENDING", "required">, import("convex/values").VLiteral<"ASK_WITH_CHILDREN", "required">, import("convex/values").VLiteral<"QUEUE_LIMIT", "required">], "required", never>;
export declare const runStatus: import("convex/values").VUnion<"failed" | "running" | "completed" | "queued" | "asking", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"asking", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">], "required", never>;
export declare const deliveryStatus: import("convex/values").VUnion<"failed" | "pending" | "accepted" | "blocked", [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"accepted", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"blocked", "required">], "required", never>;
export declare const runPhase: import("convex/values").VUnion<"failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"started", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"result_accepted", "required">, import("convex/values").VLiteral<"delivery_failed", "required">, import("convex/values").VLiteral<"delivery_blocked", "required">], "required", never>;
export declare const runEvent: import("convex/values").VObject<{
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
    at: number;
    phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
}, {
    phase: import("convex/values").VUnion<"failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"started", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"result_accepted", "required">, import("convex/values").VLiteral<"delivery_failed", "required">, import("convex/values").VLiteral<"delivery_blocked", "required">], "required", never>;
    at: import("convex/values").VFloat64<number, "required">;
    errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
}, "required", "errorCode" | "at" | "phase">;
export declare const receipt: import("convex/values").VUnion<{
    status: "accepted";
    threadId: string;
    assignmentId: string;
    position: number;
    receiptId: string;
} | {
    status: "duplicate";
    threadId: string;
    assignmentId: string;
    position: number;
    receiptId: string;
} | {
    status: "rejected";
    code: "INVALID_MESSAGE" | "KEY_CONFLICT" | "QUEUE_FULL" | "CANCELLED" | "INVALID_REQUEST_KEY" | "UNKNOWN_AGENT" | "INVALID_MODELS" | "ATTACHMENT_LIMIT" | "RECOVERY_REQUIRED";
}, [import("convex/values").VObject<{
    status: "accepted";
    threadId: string;
    assignmentId: string;
    position: number;
    receiptId: string;
}, {
    status: import("convex/values").VLiteral<"accepted", "required">;
    position: import("convex/values").VFloat64<number, "required">;
    assignmentId: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    receiptId: import("convex/values").VString<string, "required">;
}, "required", "status" | "threadId" | "assignmentId" | "position" | "receiptId">, import("convex/values").VObject<{
    status: "duplicate";
    threadId: string;
    assignmentId: string;
    position: number;
    receiptId: string;
}, {
    status: import("convex/values").VLiteral<"duplicate", "required">;
    position: import("convex/values").VFloat64<number, "required">;
    assignmentId: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    receiptId: import("convex/values").VString<string, "required">;
}, "required", "status" | "threadId" | "assignmentId" | "position" | "receiptId">, import("convex/values").VObject<{
    status: "rejected";
    code: "INVALID_MESSAGE" | "KEY_CONFLICT" | "QUEUE_FULL" | "CANCELLED" | "INVALID_REQUEST_KEY" | "UNKNOWN_AGENT" | "INVALID_MODELS" | "ATTACHMENT_LIMIT" | "RECOVERY_REQUIRED";
}, {
    status: import("convex/values").VLiteral<"rejected", "required">;
    code: import("convex/values").VUnion<"INVALID_MESSAGE" | "KEY_CONFLICT" | "QUEUE_FULL" | "CANCELLED" | "INVALID_REQUEST_KEY" | "UNKNOWN_AGENT" | "INVALID_MODELS" | "ATTACHMENT_LIMIT" | "RECOVERY_REQUIRED", [import("convex/values").VLiteral<"KEY_CONFLICT", "required">, import("convex/values").VLiteral<"QUEUE_FULL", "required">, import("convex/values").VLiteral<"CANCELLED", "required">, import("convex/values").VLiteral<"INVALID_MESSAGE", "required">, import("convex/values").VLiteral<"INVALID_REQUEST_KEY", "required">, import("convex/values").VLiteral<"UNKNOWN_AGENT", "required">, import("convex/values").VLiteral<"INVALID_MODELS", "required">, import("convex/values").VLiteral<"ATTACHMENT_LIMIT", "required">, import("convex/values").VLiteral<"RECOVERY_REQUIRED", "required">], "required", never>;
}, "required", "status" | "code">], "required", "status" | "threadId" | "assignmentId" | "code" | "position" | "receiptId">;
export declare const subagentCounts: import("convex/values").VObject<{
    active: number;
    history: number;
    total: number;
}, {
    active: import("convex/values").VFloat64<number, "required">;
    history: import("convex/values").VFloat64<number, "required">;
    total: import("convex/values").VFloat64<number, "required">;
}, "required", "active" | "history" | "total">;
export declare const activity: import("convex/values").VObject<{
    runId?: string | undefined;
    agent: string;
    turnStatus: "idle" | "running" | "queued" | "recovery_required";
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
    threadId: string;
    queuedMessages: number;
    assignmentId: string;
    assignmentStatus: "open";
    subagents: {
        active: number;
        history: number;
        total: number;
    };
}, {
    assignmentId: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
    assignmentStatus: import("convex/values").VLiteral<"open", "required">;
    turnStatus: import("convex/values").VUnion<"idle" | "running" | "queued" | "recovery_required", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"idle", "required">, import("convex/values").VLiteral<"recovery_required", "required">], "required", never>;
    queuedMessages: import("convex/values").VFloat64<number, "required">;
    errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">], "required", never>;
    /** The thread's current (or last) user run: the same `runId` slot facts and
     * budget checks receive, so a host can key a recovery step to the exact
     * stopped run. Absent before the first request is admitted. */
    runId: import("convex/values").VString<string | undefined, "optional">;
    subagents: import("convex/values").VObject<{
        active: number;
        history: number;
        total: number;
    }, {
        active: import("convex/values").VFloat64<number, "required">;
        history: import("convex/values").VFloat64<number, "required">;
        total: import("convex/values").VFloat64<number, "required">;
    }, "required", "active" | "history" | "total">;
}, "required", "agent" | "runId" | "turnStatus" | "errorCode" | "threadId" | "queuedMessages" | "assignmentId" | "assignmentStatus" | "subagents" | "subagents.active" | "subagents.history" | "subagents.total">;
export declare const scope: import("convex/values").VObject<{
    agent: string;
    subject: string;
    threadId: string;
    assignmentId: string;
}, {
    assignmentId: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    subject: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
}, "required", "agent" | "subject" | "threadId" | "assignmentId">;
export declare const subagentRun: import("convex/values").VObject<{
    startedAt: number | null;
    events: {
        agent: string;
        runId: string;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
        at: number;
        phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
    }[];
    status: "failed" | "running" | "completed" | "queued" | "asking";
    agent: string;
    runId: string;
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
    deliveryStatus: "failed" | "pending" | "accepted" | "blocked";
    side: boolean;
    childThreadId: string | null;
    createdAt: number;
    resultMessageId: string | null;
    finishedAt: number | null;
    deliveryAt: number | null;
}, {
    runId: import("convex/values").VString<string, "required">;
    side: import("convex/values").VBoolean<boolean, "required">;
    childThreadId: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    agent: import("convex/values").VString<string, "required">;
    status: import("convex/values").VUnion<"failed" | "running" | "completed" | "queued" | "asking", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"asking", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">], "required", never>;
    deliveryStatus: import("convex/values").VUnion<"failed" | "pending" | "accepted" | "blocked", [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"accepted", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"blocked", "required">], "required", never>;
    createdAt: import("convex/values").VFloat64<number, "required">;
    startedAt: import("convex/values").VUnion<number | null, [import("convex/values").VNull<null, "required">, import("convex/values").VFloat64<number, "required">], "required", never>;
    finishedAt: import("convex/values").VUnion<number | null, [import("convex/values").VNull<null, "required">, import("convex/values").VFloat64<number, "required">], "required", never>;
    deliveryAt: import("convex/values").VUnion<number | null, [import("convex/values").VNull<null, "required">, import("convex/values").VFloat64<number, "required">], "required", never>;
    resultMessageId: import("convex/values").VUnion<string | null, [import("convex/values").VNull<null, "required">, import("convex/values").VString<string, "required">], "required", never>;
    errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
    events: import("convex/values").VArray<{
        agent: string;
        runId: string;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
        at: number;
        phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
    }[], import("convex/values").VObject<{
        agent: string;
        runId: string;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
        at: number;
        phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
    }, {
        runId: import("convex/values").VString<string, "required">;
        agent: import("convex/values").VString<string, "required">;
        phase: import("convex/values").VUnion<"failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"started", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"result_accepted", "required">, import("convex/values").VLiteral<"delivery_failed", "required">, import("convex/values").VLiteral<"delivery_blocked", "required">], "required", never>;
        at: import("convex/values").VFloat64<number, "required">;
        errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
    }, "required", "agent" | "runId" | "errorCode" | "at" | "phase">, "required">;
}, "required", "startedAt" | "events" | "status" | "agent" | "runId" | "errorCode" | "deliveryStatus" | "side" | "childThreadId" | "createdAt" | "resultMessageId" | "finishedAt" | "deliveryAt">;
export declare const vPaginationResult: <T extends Validator<unknown, "required", string>>(item: T) => import("convex/values").VObject<{
    page: T["type"][];
    continueCursor: string;
    isDone: boolean;
}, {
    page: import("convex/values").VArray<T["type"][], T, "required">;
    continueCursor: import("convex/values").VString<string, "required">;
    isDone: import("convex/values").VBoolean<boolean, "required">;
}, "required", "page" | "continueCursor" | "isDone">;
export declare const pendingGeneration: import("convex/values").VObject<{
    stream?: {
        id: string;
        abort: string;
    } | undefined;
    epoch: number;
    messageId: string;
    executionId: string;
    getMessages: string;
    finalizeMessage: string;
}, {
    messageId: import("convex/values").VString<string, "required">;
    executionId: import("convex/values").VString<string, "required">;
    epoch: import("convex/values").VFloat64<number, "required">;
    getMessages: import("convex/values").VString<string, "required">;
    finalizeMessage: import("convex/values").VString<string, "required">;
    stream: import("convex/values").VObject<{
        id: string;
        abort: string;
    } | undefined, {
        id: import("convex/values").VString<string, "required">;
        abort: import("convex/values").VString<string, "required">;
    }, "optional", "id" | "abort">;
}, "required", "stream" | "epoch" | "messageId" | "executionId" | "getMessages" | "finalizeMessage" | "stream.id" | "stream.abort">;
declare const _default: import("convex/server").SchemaDefinition<{
    assignments: import("convex/server").TableDefinition<import("convex/values").VObject<{
        workflowId?: string | undefined;
        runId?: import("convex/values").GenericId<"runs"> | undefined;
        textConfig?: {
            everyTurns?: number | undefined;
            worker: string;
            title: boolean;
            summary: boolean;
            updateThread: string;
            getThread: string;
        } | undefined;
        titleVersion?: number | undefined;
        titleSource?: "auto" | "user" | undefined;
        titleTask?: {
            dispatched?: boolean | undefined;
            again?: import("convex/values").GenericId<"runs"> | undefined;
            deferred?: boolean | undefined;
            titleRef?: {
                order: number;
                bytes: number;
                id: string;
                stepOrder: number;
            } | undefined;
            status: "failed" | "running" | "queued" | "done" | "unknown";
            key: string;
            runId: import("convex/values").GenericId<"runs">;
            epoch: number;
            version: number;
        } | undefined;
        summaryTask?: {
            dispatched?: boolean | undefined;
            again?: import("convex/values").GenericId<"runs"> | undefined;
            deferred?: boolean | undefined;
            titleRef?: {
                order: number;
                bytes: number;
                id: string;
                stepOrder: number;
            } | undefined;
            status: "failed" | "running" | "queued" | "done" | "unknown";
            key: string;
            runId: import("convex/values").GenericId<"runs">;
            epoch: number;
            version: number;
        } | undefined;
        textCompleted?: {
            order: number;
            id: string;
            stepOrder: number;
            sequence: number;
        } | undefined;
        textSummary?: {
            text: string;
            through: {
                order: number;
                id: string;
                stepOrder: number;
                sequence: number;
            };
        } | undefined;
        modelStep?: {
            stepOrder: number;
            messageId: string;
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
            turn: number;
            at: number;
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
            epoch: number;
            messageId: string;
            executionId: string;
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
                effective?: boolean | undefined;
                key: string;
                messageId: string;
                proposalId: import("convex/values").GenericId<"receipts">;
                providerExecuted: boolean;
                toolCallKey: ArrayBuffer;
            }[];
        } | undefined;
        lastSlice?: string | undefined;
        notesPending: number;
        agent: string;
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
        turnStatus: "idle" | "running" | "queued" | "recovery_required";
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
        completedTurns: number;
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
    }, {
        textConfig: import("convex/values").VObject<{
            everyTurns?: number | undefined;
            worker: string;
            title: boolean;
            summary: boolean;
            updateThread: string;
            getThread: string;
        } | undefined, {
            worker: import("convex/values").VString<string, "required">;
            updateThread: import("convex/values").VString<string, "required">;
            getThread: import("convex/values").VString<string, "required">;
            title: import("convex/values").VBoolean<boolean, "required">;
            summary: import("convex/values").VBoolean<boolean, "required">;
            everyTurns: import("convex/values").VFloat64<number | undefined, "optional">;
        }, "optional", "worker" | "title" | "summary" | "updateThread" | "getThread" | "everyTurns">;
        titleVersion: import("convex/values").VFloat64<number | undefined, "optional">;
        titleSource: import("convex/values").VUnion<"auto" | "user" | undefined, [import("convex/values").VLiteral<"auto", "required">, import("convex/values").VLiteral<"user", "required">], "optional", never>;
        titleTask: import("convex/values").VObject<{
            dispatched?: boolean | undefined;
            again?: import("convex/values").GenericId<"runs"> | undefined;
            deferred?: boolean | undefined;
            titleRef?: {
                order: number;
                bytes: number;
                id: string;
                stepOrder: number;
            } | undefined;
            status: "failed" | "running" | "queued" | "done" | "unknown";
            key: string;
            runId: import("convex/values").GenericId<"runs">;
            epoch: number;
            version: number;
        } | undefined, {
            key: import("convex/values").VString<string, "required">;
            runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
            epoch: import("convex/values").VFloat64<number, "required">;
            version: import("convex/values").VFloat64<number, "required">;
            status: import("convex/values").VUnion<"failed" | "running" | "queued" | "done" | "unknown", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
            dispatched: import("convex/values").VBoolean<boolean | undefined, "optional">;
            again: import("convex/values").VId<import("convex/values").GenericId<"runs"> | undefined, "optional">;
            deferred: import("convex/values").VBoolean<boolean | undefined, "optional">;
            titleRef: import("convex/values").VObject<{
                order: number;
                bytes: number;
                id: string;
                stepOrder: number;
            } | undefined, {
                id: import("convex/values").VString<string, "required">;
                order: import("convex/values").VFloat64<number, "required">;
                stepOrder: import("convex/values").VFloat64<number, "required">;
                bytes: import("convex/values").VFloat64<number, "required">;
            }, "optional", "order" | "bytes" | "id" | "stepOrder">;
        }, "optional", "status" | "key" | "runId" | "epoch" | "version" | "dispatched" | "again" | "deferred" | "titleRef" | "titleRef.order" | "titleRef.bytes" | "titleRef.id" | "titleRef.stepOrder">;
        summaryTask: import("convex/values").VObject<{
            dispatched?: boolean | undefined;
            again?: import("convex/values").GenericId<"runs"> | undefined;
            deferred?: boolean | undefined;
            titleRef?: {
                order: number;
                bytes: number;
                id: string;
                stepOrder: number;
            } | undefined;
            status: "failed" | "running" | "queued" | "done" | "unknown";
            key: string;
            runId: import("convex/values").GenericId<"runs">;
            epoch: number;
            version: number;
        } | undefined, {
            key: import("convex/values").VString<string, "required">;
            runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
            epoch: import("convex/values").VFloat64<number, "required">;
            version: import("convex/values").VFloat64<number, "required">;
            status: import("convex/values").VUnion<"failed" | "running" | "queued" | "done" | "unknown", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
            dispatched: import("convex/values").VBoolean<boolean | undefined, "optional">;
            again: import("convex/values").VId<import("convex/values").GenericId<"runs"> | undefined, "optional">;
            deferred: import("convex/values").VBoolean<boolean | undefined, "optional">;
            titleRef: import("convex/values").VObject<{
                order: number;
                bytes: number;
                id: string;
                stepOrder: number;
            } | undefined, {
                id: import("convex/values").VString<string, "required">;
                order: import("convex/values").VFloat64<number, "required">;
                stepOrder: import("convex/values").VFloat64<number, "required">;
                bytes: import("convex/values").VFloat64<number, "required">;
            }, "optional", "order" | "bytes" | "id" | "stepOrder">;
        }, "optional", "status" | "key" | "runId" | "epoch" | "version" | "dispatched" | "again" | "deferred" | "titleRef" | "titleRef.order" | "titleRef.bytes" | "titleRef.id" | "titleRef.stepOrder">;
        textCompleted: import("convex/values").VObject<{
            order: number;
            id: string;
            stepOrder: number;
            sequence: number;
        } | undefined, {
            id: import("convex/values").VString<string, "required">;
            order: import("convex/values").VFloat64<number, "required">;
            stepOrder: import("convex/values").VFloat64<number, "required">;
            sequence: import("convex/values").VFloat64<number, "required">;
        }, "optional", "order" | "id" | "stepOrder" | "sequence">;
        textSummary: import("convex/values").VObject<{
            text: string;
            through: {
                order: number;
                id: string;
                stepOrder: number;
                sequence: number;
            };
        } | undefined, {
            text: import("convex/values").VString<string, "required">;
            through: import("convex/values").VObject<{
                order: number;
                id: string;
                stepOrder: number;
                sequence: number;
            }, {
                id: import("convex/values").VString<string, "required">;
                order: import("convex/values").VFloat64<number, "required">;
                stepOrder: import("convex/values").VFloat64<number, "required">;
                sequence: import("convex/values").VFloat64<number, "required">;
            }, "required", "order" | "id" | "stepOrder" | "sequence">;
        }, "optional", "text" | "through" | "through.order" | "through.id" | "through.stepOrder" | "through.sequence">;
        modelStep: import("convex/values").VObject<{
            stepOrder: number;
            messageId: string;
        } | undefined, {
            messageId: import("convex/values").VString<string, "required">;
            stepOrder: import("convex/values").VFloat64<number, "required">;
        }, "optional", "stepOrder" | "messageId">;
        contextMessages: import("convex/values").VArray<{
            order: number;
            bytes: number;
            id: string;
            stepOrder: number;
            sequence: number;
        }[] | undefined, import("convex/values").VObject<{
            order: number;
            bytes: number;
            id: string;
            stepOrder: number;
            sequence: number;
        }, {
            id: import("convex/values").VString<string, "required">;
            order: import("convex/values").VFloat64<number, "required">;
            stepOrder: import("convex/values").VFloat64<number, "required">;
            bytes: import("convex/values").VFloat64<number, "required">;
            sequence: import("convex/values").VFloat64<number, "required">;
        }, "required", "order" | "bytes" | "id" | "stepOrder" | "sequence">, "optional">;
        reviewed: import("convex/values").VArray<{
            agent: string;
            turn: number;
            at: number;
            boundary: number;
        }[] | undefined, import("convex/values").VObject<{
            agent: string;
            turn: number;
            at: number;
            boundary: number;
        }, {
            agent: import("convex/values").VString<string, "required">;
            turn: import("convex/values").VFloat64<number, "required">;
            at: import("convex/values").VFloat64<number, "required">;
            boundary: import("convex/values").VFloat64<number, "required">;
        }, "required", "agent" | "turn" | "at" | "boundary">, "optional">;
        completedTurns: import("convex/values").VFloat64<number, "required">;
        notesPending: import("convex/values").VFloat64<number, "required">;
        routingAgentIndex: import("convex/values").VFloat64<number | undefined, "optional">;
        hookContinue: import("convex/values").VBoolean<boolean | undefined, "optional">;
        subject: import("convex/values").VString<string, "required">;
        agent: import("convex/values").VString<string, "required">;
        threadId: import("convex/values").VString<string, "required">;
        models: import("convex/values").VRecord<Record<string, string> | undefined, import("convex/values").VString<string, "required">, import("convex/values").VString<string, "required">, "optional", string>;
        runTurn: import("convex/values").VString<string, "required">;
        workflowId: import("convex/values").VString<string | undefined, "optional">;
        limits: import("convex/values").VObject<{
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
        }, {
            attachmentBytes: import("convex/values").VFloat64<number, "required">;
            continuesPerRun: import("convex/values").VFloat64<number, "required">;
            sideRunsPerRun: import("convex/values").VFloat64<number, "required">;
            notesPending: import("convex/values").VFloat64<number, "required">;
            maxDepth: import("convex/values").VFloat64<number, "required">;
            messagesPerChild: import("convex/values").VFloat64<number, "required">;
            rootLane: import("convex/values").VFloat64<number, "required">;
            childLane: import("convex/values").VFloat64<number, "required">;
            runLaunches: import("convex/values").VFloat64<number, "required">;
            runHops: import("convex/values").VFloat64<number, "required">;
            activeChildrenPerRoot: import("convex/values").VFloat64<number, "required">;
            taskLength: import("convex/values").VFloat64<number, "required">;
            queueLength: import("convex/values").VFloat64<number, "required">;
            slicesPerTurn: import("convex/values").VFloat64<number, "required">;
            leaseMs: import("convex/values").VFloat64<number, "required">;
        }, "required", "attachmentBytes" | "continuesPerRun" | "sideRunsPerRun" | "notesPending" | "maxDepth" | "messagesPerChild" | "rootLane" | "childLane" | "runLaunches" | "runHops" | "activeChildrenPerRoot" | "taskLength" | "queueLength" | "slicesPerTurn" | "leaseMs">;
        loopWaiting: import("convex/values").VBoolean<boolean | undefined, "optional">;
        pinged: import("convex/values").VBoolean<boolean | undefined, "optional">;
        recoveryAt: import("convex/values").VFloat64<number | undefined, "optional">;
        recoveryJobId: import("convex/values").VId<import("convex/values").GenericId<"_scheduled_functions"> | undefined, "optional">;
        recoveryDelayMs: import("convex/values").VFloat64<number | undefined, "optional">;
        modelSteps: import("convex/values").VFloat64<number | undefined, "optional">;
        watchdogId: import("convex/values").VId<import("convex/values").GenericId<"_scheduled_functions"> | undefined, "optional">;
        pendingGeneration: import("convex/values").VObject<{
            stream?: {
                id: string;
                abort: string;
            } | undefined;
            epoch: number;
            messageId: string;
            executionId: string;
            getMessages: string;
            finalizeMessage: string;
        } | undefined, {
            messageId: import("convex/values").VString<string, "required">;
            executionId: import("convex/values").VString<string, "required">;
            epoch: import("convex/values").VFloat64<number, "required">;
            getMessages: import("convex/values").VString<string, "required">;
            finalizeMessage: import("convex/values").VString<string, "required">;
            stream: import("convex/values").VObject<{
                id: string;
                abort: string;
            } | undefined, {
                id: import("convex/values").VString<string, "required">;
                abort: import("convex/values").VString<string, "required">;
            }, "optional", "id" | "abort">;
        }, "optional", "stream" | "epoch" | "messageId" | "executionId" | "getMessages" | "finalizeMessage" | "stream.id" | "stream.abort">;
        cancellationEpoch: import("convex/values").VFloat64<number, "required">;
        cancelled: import("convex/values").VBoolean<boolean, "required">;
        runId: import("convex/values").VId<import("convex/values").GenericId<"runs"> | undefined, "optional">;
        childRunId: import("convex/values").VString<string | undefined, "optional">;
        rootAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments"> | undefined, "optional">;
        turnStatus: import("convex/values").VUnion<"idle" | "running" | "queued" | "recovery_required", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"idle", "required">, import("convex/values").VLiteral<"recovery_required", "required">], "required", never>;
        errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">], "required", never>;
        queuedMessages: import("convex/values").VFloat64<number, "required">;
        nextSequence: import("convex/values").VFloat64<number, "required">;
        nextTurn: import("convex/values").VFloat64<number, "required">;
        turnToken: import("convex/values").VString<string | undefined, "optional">;
        promptMessageId: import("convex/values").VString<string | undefined, "optional">;
        turnOrigin: import("convex/values").VUnion<"user" | "subagent_result" | undefined, [import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"subagent_result", "required">], "optional", never>;
        inboxId: import("convex/values").VId<import("convex/values").GenericId<"inbox"> | undefined, "optional">;
        approvalBlocked: import("convex/values").VBoolean<boolean | undefined, "optional">;
        approvals: import("convex/values").VObject<{
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
        } | undefined, {
            inboxId: import("convex/values").VId<import("convex/values").GenericId<"inbox">, "required">;
            epoch: import("convex/values").VFloat64<number, "required">;
            getMessages: import("convex/values").VString<string, "required">;
            addMessages: import("convex/values").VString<string, "required">;
            cleanupPending: import("convex/values").VBoolean<boolean | undefined, "optional">;
            requests: import("convex/values").VArray<{
                deferred?: boolean | undefined;
                resolved?: true | undefined;
                effective?: boolean | undefined;
                key: string;
                messageId: string;
                proposalId: import("convex/values").GenericId<"receipts">;
                providerExecuted: boolean;
                toolCallKey: ArrayBuffer;
            }[], import("convex/values").VObject<{
                deferred?: boolean | undefined;
                resolved?: true | undefined;
                effective?: boolean | undefined;
                key: string;
                messageId: string;
                proposalId: import("convex/values").GenericId<"receipts">;
                providerExecuted: boolean;
                toolCallKey: ArrayBuffer;
            }, {
                deferred: import("convex/values").VBoolean<boolean | undefined, "optional">;
                key: import("convex/values").VString<string, "required">;
                messageId: import("convex/values").VString<string, "required">;
                proposalId: import("convex/values").VId<import("convex/values").GenericId<"receipts">, "required">;
                providerExecuted: import("convex/values").VBoolean<boolean, "required">;
                toolCallKey: import("convex/values").VBytes<ArrayBuffer, "required">;
                resolved: import("convex/values").VLiteral<true | undefined, "optional">;
                effective: import("convex/values").VBoolean<boolean | undefined, "optional">;
            }, "required", "key" | "deferred" | "messageId" | "proposalId" | "providerExecuted" | "toolCallKey" | "resolved" | "effective">, "required">;
        }, "optional", "epoch" | "getMessages" | "inboxId" | "addMessages" | "cleanupPending" | "requests">;
        lastSlice: import("convex/values").VString<string | undefined, "optional">;
        activeRuns: import("convex/values").VFloat64<number, "required">;
        nextRunSequence: import("convex/values").VFloat64<number, "required">;
    }, "required", "workflowId" | "notesPending" | "agent" | "runId" | "limits" | "turnStatus" | "errorCode" | "textConfig" | "titleVersion" | "titleSource" | "titleTask" | "summaryTask" | "textCompleted" | "textSummary" | "modelStep" | "contextMessages" | "reviewed" | "completedTurns" | "routingAgentIndex" | "hookContinue" | "subject" | "threadId" | "models" | "runTurn" | "loopWaiting" | "pinged" | "recoveryAt" | "recoveryJobId" | "recoveryDelayMs" | "modelSteps" | "watchdogId" | "pendingGeneration" | "cancellationEpoch" | "cancelled" | "childRunId" | "rootAssignmentId" | "queuedMessages" | "nextSequence" | "nextTurn" | "turnToken" | "promptMessageId" | "turnOrigin" | "inboxId" | "approvalBlocked" | "approvals" | "lastSlice" | "activeRuns" | "nextRunSequence" | "limits.attachmentBytes" | "limits.continuesPerRun" | "limits.sideRunsPerRun" | "limits.notesPending" | "limits.maxDepth" | "limits.messagesPerChild" | "limits.rootLane" | "limits.childLane" | "limits.runLaunches" | "limits.runHops" | "limits.activeChildrenPerRoot" | "limits.taskLength" | "limits.queueLength" | "limits.slicesPerTurn" | "limits.leaseMs" | "textConfig.worker" | "textConfig.title" | "textConfig.summary" | "textConfig.updateThread" | "textConfig.getThread" | "textConfig.everyTurns" | "titleTask.status" | "titleTask.key" | "titleTask.runId" | "titleTask.epoch" | "titleTask.version" | "titleTask.dispatched" | "titleTask.again" | "titleTask.deferred" | "titleTask.titleRef" | "titleTask.titleRef.order" | "titleTask.titleRef.bytes" | "titleTask.titleRef.id" | "titleTask.titleRef.stepOrder" | "summaryTask.status" | "summaryTask.key" | "summaryTask.runId" | "summaryTask.epoch" | "summaryTask.version" | "summaryTask.dispatched" | "summaryTask.again" | "summaryTask.deferred" | "summaryTask.titleRef" | "summaryTask.titleRef.order" | "summaryTask.titleRef.bytes" | "summaryTask.titleRef.id" | "summaryTask.titleRef.stepOrder" | "textCompleted.order" | "textCompleted.id" | "textCompleted.stepOrder" | "textCompleted.sequence" | "textSummary.text" | "textSummary.through" | "textSummary.through.order" | "textSummary.through.id" | "textSummary.through.stepOrder" | "textSummary.through.sequence" | "modelStep.stepOrder" | "modelStep.messageId" | `models.${string}` | "pendingGeneration.stream" | "pendingGeneration.epoch" | "pendingGeneration.messageId" | "pendingGeneration.executionId" | "pendingGeneration.getMessages" | "pendingGeneration.finalizeMessage" | "pendingGeneration.stream.id" | "pendingGeneration.stream.abort" | "approvals.epoch" | "approvals.getMessages" | "approvals.inboxId" | "approvals.addMessages" | "approvals.cleanupPending" | "approvals.requests">, {
        by_thread: ["threadId", "_creationTime"];
    }, {}, {}>;
    inbox: import("convex/server").TableDefinition<import("convex/values").VObject<{
        from?: string | undefined;
        join?: {
            newestSequence: number;
            earliestId: string;
            earliestSequence: number;
        } | undefined;
        text?: string | undefined;
        passive?: boolean | undefined;
        noteEpoch?: number | undefined;
        kind: "result" | "user" | "parent" | "note" | "continue";
        sequence: number;
        runId: import("convex/values").GenericId<"runs">;
        messageId: string;
        assignmentId: import("convex/values").GenericId<"assignments">;
    }, {
        assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
        messageId: import("convex/values").VString<string, "required">;
        sequence: import("convex/values").VFloat64<number, "required">;
        passive: import("convex/values").VBoolean<boolean | undefined, "optional">;
        text: import("convex/values").VString<string | undefined, "optional">;
        noteEpoch: import("convex/values").VFloat64<number | undefined, "optional">;
        from: import("convex/values").VString<string | undefined, "optional">;
        join: import("convex/values").VObject<{
            newestSequence: number;
            earliestId: string;
            earliestSequence: number;
        } | undefined, {
            newestSequence: import("convex/values").VFloat64<number, "required">;
            earliestId: import("convex/values").VString<string, "required">;
            earliestSequence: import("convex/values").VFloat64<number, "required">;
        }, "optional", "newestSequence" | "earliestId" | "earliestSequence">;
        runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
        kind: import("convex/values").VUnion<"result" | "user" | "parent" | "note" | "continue", [import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"result", "required">, import("convex/values").VLiteral<"parent", "required">, import("convex/values").VLiteral<"note", "required">, import("convex/values").VLiteral<"continue", "required">], "required", never>;
    }, "required", "from" | "join" | "kind" | "sequence" | "runId" | "text" | "messageId" | "assignmentId" | "passive" | "noteEpoch" | "join.newestSequence" | "join.earliestId" | "join.earliestSequence">, {
        by_message: ["messageId", "_creationTime"];
        by_assignment_ready: ["assignmentId", "passive", "noteEpoch", "sequence", "_creationTime"];
    }, {}, {}>;
    runs: import("convex/server").TableDefinition<import("convex/values").VObject<{
        settings?: {
            agent: string;
            settings: {
                askUser?: boolean | undefined;
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
    }, {
        usagePartial: import("convex/values").VBoolean<boolean | undefined, "optional">;
        settings: import("convex/values").VArray<{
            agent: string;
            settings: {
                askUser?: boolean | undefined;
                mode: "stream" | "generate";
                maxOutputTokens: number;
                modelTimeoutMs: number;
                toolTimeoutMs: number;
                stepsPerTurn: number;
            };
        }[] | undefined, import("convex/values").VObject<{
            agent: string;
            settings: {
                askUser?: boolean | undefined;
                mode: "stream" | "generate";
                maxOutputTokens: number;
                modelTimeoutMs: number;
                toolTimeoutMs: number;
                stepsPerTurn: number;
            };
        }, {
            agent: import("convex/values").VString<string, "required">;
            settings: import("convex/values").VObject<{
                askUser?: boolean | undefined;
                mode: "stream" | "generate";
                maxOutputTokens: number;
                modelTimeoutMs: number;
                toolTimeoutMs: number;
                stepsPerTurn: number;
            }, {
                askUser: import("convex/values").VBoolean<boolean | undefined, "optional">;
                mode: import("convex/values").VUnion<"stream" | "generate", [import("convex/values").VLiteral<"stream", "required">, import("convex/values").VLiteral<"generate", "required">], "required", never>;
                maxOutputTokens: import("convex/values").VFloat64<number, "required">;
                modelTimeoutMs: import("convex/values").VFloat64<number, "required">;
                toolTimeoutMs: import("convex/values").VFloat64<number, "required">;
                stepsPerTurn: import("convex/values").VFloat64<number, "required">;
            }, "required", "askUser" | "mode" | "maxOutputTokens" | "modelTimeoutMs" | "toolTimeoutMs" | "stepsPerTurn">;
        }, "required", "agent" | "settings" | "settings.askUser" | "settings.mode" | "settings.maxOutputTokens" | "settings.modelTimeoutMs" | "settings.toolTimeoutMs" | "settings.stepsPerTurn">, "optional">;
        models: import("convex/values").VRecord<Record<string, string> | undefined, import("convex/values").VString<string, "required">, import("convex/values").VString<string, "required">, "optional", string>;
        startedAgents: import("convex/values").VInt64<bigint, "required">;
        routingAgents: import("convex/values").VInt64<bigint, "required">;
        continues: import("convex/values").VFloat64<number, "required">;
        sideRuns: import("convex/values").VFloat64<number, "required">;
        launches: import("convex/values").VFloat64<number, "required">;
        hops: import("convex/values").VFloat64<number, "required">;
        cancelled: import("convex/values").VBoolean<boolean, "required">;
    }, "required", "settings" | "models" | "cancelled" | `models.${string}` | "usagePartial" | "startedAgents" | "routingAgents" | "continues" | "sideRuns" | "launches" | "hops">, {}, {}, {}>;
    receipts: import("convex/server").TableDefinition<import("convex/values").VUnion<{
        result: {
            schema?: any;
            truncated?: true | undefined;
            approved?: {
                toolCallId: string;
                input: any;
                edited: boolean;
                originalHash: string;
                effectiveHash: string;
            } | undefined;
            id: string;
            providerExecuted: boolean;
            toolCallId: string;
            tool: string;
            input: any;
        };
        kind: "proposal";
    } | {
        result?: any;
        claim?: string | undefined;
        leaseUntil?: number | undefined;
        kind: "effect";
        status: "failed" | "running" | "done" | "unknown";
        key: string;
        scope: string;
        fingerprint: string;
        expiresAt: number;
    } | {
        messageId?: string | undefined;
        threadId?: string | undefined;
        kind: "attachment";
        subject: string;
        native: string;
        fileId: string;
    }, [import("convex/values").VObject<{
        result: {
            schema?: any;
            truncated?: true | undefined;
            approved?: {
                toolCallId: string;
                input: any;
                edited: boolean;
                originalHash: string;
                effectiveHash: string;
            } | undefined;
            id: string;
            providerExecuted: boolean;
            toolCallId: string;
            tool: string;
            input: any;
        };
        kind: "proposal";
    }, {
        kind: import("convex/values").VLiteral<"proposal", "required">;
        result: import("convex/values").VObject<{
            schema?: any;
            truncated?: true | undefined;
            approved?: {
                toolCallId: string;
                input: any;
                edited: boolean;
                originalHash: string;
                effectiveHash: string;
            } | undefined;
            id: string;
            providerExecuted: boolean;
            toolCallId: string;
            tool: string;
            input: any;
        }, {
            approved: import("convex/values").VObject<{
                toolCallId: string;
                input: any;
                edited: boolean;
                originalHash: string;
                effectiveHash: string;
            } | undefined, {
                edited: import("convex/values").VBoolean<boolean, "required">;
                toolCallId: import("convex/values").VString<string, "required">;
                input: import("convex/values").VAny<any, "required", string>;
                originalHash: import("convex/values").VString<string, "required">;
                effectiveHash: import("convex/values").VString<string, "required">;
            }, "optional", "toolCallId" | "input" | `input.${string}` | "edited" | "originalHash" | "effectiveHash">;
            id: import("convex/values").VString<string, "required">;
            toolCallId: import("convex/values").VString<string, "required">;
            tool: import("convex/values").VString<string, "required">;
            input: import("convex/values").VAny<any, "required", string>;
            providerExecuted: import("convex/values").VBoolean<boolean, "required">;
            schema: import("convex/values").VAny<any, "optional", string>;
            truncated: import("convex/values").VLiteral<true | undefined, "optional">;
        }, "required", "id" | "providerExecuted" | "toolCallId" | "tool" | "input" | "schema" | "truncated" | `input.${string}` | `schema.${string}` | "approved" | "approved.toolCallId" | "approved.input" | `approved.input.${string}` | "approved.edited" | "approved.originalHash" | "approved.effectiveHash">;
    }, "required", "result" | "kind" | "result.id" | "result.providerExecuted" | "result.toolCallId" | "result.tool" | "result.input" | "result.schema" | "result.truncated" | `result.input.${string}` | `result.schema.${string}` | "result.approved" | "result.approved.toolCallId" | "result.approved.input" | `result.approved.input.${string}` | "result.approved.edited" | "result.approved.originalHash" | "result.approved.effectiveHash">, import("convex/values").VObject<{
        result?: any;
        claim?: string | undefined;
        leaseUntil?: number | undefined;
        kind: "effect";
        status: "failed" | "running" | "done" | "unknown";
        key: string;
        scope: string;
        fingerprint: string;
        expiresAt: number;
    }, {
        kind: import("convex/values").VLiteral<"effect", "required">;
        scope: import("convex/values").VString<string, "required">;
        key: import("convex/values").VString<string, "required">;
        fingerprint: import("convex/values").VString<string, "required">;
        status: import("convex/values").VUnion<"failed" | "running" | "done" | "unknown", [import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
        claim: import("convex/values").VString<string | undefined, "optional">;
        leaseUntil: import("convex/values").VFloat64<number | undefined, "optional">;
        result: import("convex/values").VAny<any, "optional", string>;
        expiresAt: import("convex/values").VFloat64<number, "required">;
    }, "required", "result" | "kind" | "status" | "key" | "scope" | "fingerprint" | "claim" | "leaseUntil" | "expiresAt" | `result.${string}`>, import("convex/values").VObject<{
        messageId?: string | undefined;
        threadId?: string | undefined;
        kind: "attachment";
        subject: string;
        native: string;
        fileId: string;
    }, {
        kind: import("convex/values").VLiteral<"attachment", "required">;
        native: import("convex/values").VString<string, "required">;
        fileId: import("convex/values").VString<string, "required">;
        subject: import("convex/values").VString<string, "required">;
        threadId: import("convex/values").VString<string | undefined, "optional">;
        messageId: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "kind" | "messageId" | "subject" | "threadId" | "native" | "fileId">], "required", "result" | "kind" | "status" | "key" | "messageId" | "subject" | "threadId" | `result.input.${string}` | `result.schema.${string}` | `result.approved.input.${string}` | "scope" | "fingerprint" | "claim" | "leaseUntil" | "expiresAt" | `result.${string}` | "native" | "fileId">, {
        by_scope_key: ["scope", "key", "_creationTime"];
        by_expiry: ["kind", "expiresAt", "_creationTime"];
        by_file: ["native", "fileId", "subject", "threadId", "_creationTime"];
        by_message: ["native", "messageId", "_creationTime"];
    }, {}, {}>;
    subagentRuns: import("convex/server").TableDefinition<import("convex/values").VObject<{
        join?: "open" | "sealed" | "ready" | "joined" | undefined;
        startedAt?: number | undefined;
        side?: boolean | undefined;
        group?: string | undefined;
        questionMessageId?: string | undefined;
        childAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
        childThreadId?: string | undefined;
        childResultMessageId?: string | undefined;
        lastTurnResult?: {
            messageId?: string | undefined;
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
        } | undefined;
        resultMessageId?: string | undefined;
        resultSequence?: number | undefined;
        events: {
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            at: number;
            phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
        }[];
        status: "failed" | "running" | "completed" | "queued" | "asking";
        agent: string;
        sequence: number;
        runId: string;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
        rootAssignmentId: import("convex/values").GenericId<"assignments">;
        deliveryStatus: "failed" | "pending" | "accepted" | "blocked";
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
        createdAt: number;
    }, {
        side: import("convex/values").VBoolean<boolean | undefined, "optional">;
        runId: import("convex/values").VString<string, "required">;
        rootCancellationEpoch: import("convex/values").VFloat64<number, "required">;
        parentRunId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
        dedupKey: import("convex/values").VString<string, "required">;
        payloadFingerprint: import("convex/values").VString<string, "required">;
        rootAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
        actorAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
        depth: import("convex/values").VFloat64<number, "required">;
        group: import("convex/values").VString<string | undefined, "optional">;
        join: import("convex/values").VUnion<"open" | "sealed" | "ready" | "joined" | undefined, [import("convex/values").VLiteral<"open", "required">, import("convex/values").VLiteral<"sealed", "required">, import("convex/values").VLiteral<"ready", "required">, import("convex/values").VLiteral<"joined", "required">], "optional", never>;
        questionMessageId: import("convex/values").VString<string | undefined, "optional">;
        messagesReceived: import("convex/values").VFloat64<number, "required">;
        childAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments"> | undefined, "optional">;
        childThreadId: import("convex/values").VString<string | undefined, "optional">;
        childResultMessageId: import("convex/values").VString<string | undefined, "optional">;
        lastTurnResult: import("convex/values").VObject<{
            messageId?: string | undefined;
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
        } | undefined, {
            messageId: import("convex/values").VString<string | undefined, "optional">;
            errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
        }, "optional", "errorCode" | "messageId">;
        agent: import("convex/values").VString<string, "required">;
        actorAgent: import("convex/values").VString<string, "required">;
        status: import("convex/values").VUnion<"failed" | "running" | "completed" | "queued" | "asking", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"asking", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">], "required", never>;
        deliveryStatus: import("convex/values").VUnion<"failed" | "pending" | "accepted" | "blocked", [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"accepted", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"blocked", "required">], "required", never>;
        errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
        deliveryToken: import("convex/values").VString<string, "required">;
        coordinateHandle: import("convex/values").VString<string, "required">;
        createdAt: import("convex/values").VFloat64<number, "required">;
        sequence: import("convex/values").VFloat64<number, "required">;
        startedAt: import("convex/values").VFloat64<number | undefined, "optional">;
        resultMessageId: import("convex/values").VString<string | undefined, "optional">;
        resultSequence: import("convex/values").VFloat64<number | undefined, "optional">;
        events: import("convex/values").VArray<{
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            at: number;
            phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
        }[], import("convex/values").VObject<{
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            at: number;
            phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
        }, {
            phase: import("convex/values").VUnion<"failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"started", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"result_accepted", "required">, import("convex/values").VLiteral<"delivery_failed", "required">, import("convex/values").VLiteral<"delivery_blocked", "required">], "required", never>;
            at: import("convex/values").VFloat64<number, "required">;
            errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
        }, "required", "errorCode" | "at" | "phase">, "required">;
    }, "required", "join" | "startedAt" | "events" | "status" | "agent" | "sequence" | "runId" | "errorCode" | "rootAssignmentId" | "deliveryStatus" | "side" | "rootCancellationEpoch" | "parentRunId" | "dedupKey" | "payloadFingerprint" | "actorAssignmentId" | "depth" | "group" | "questionMessageId" | "messagesReceived" | "childAssignmentId" | "childThreadId" | "childResultMessageId" | "lastTurnResult" | "actorAgent" | "deliveryToken" | "coordinateHandle" | "createdAt" | "resultMessageId" | "resultSequence" | "lastTurnResult.errorCode" | "lastTurnResult.messageId">, {
        by_result_message: ["resultMessageId", "_creationTime"];
        by_dedup: ["dedupKey", "_creationTime"];
        by_run: ["runId", "_creationTime"];
        by_root_sequence: ["rootAssignmentId", "sequence", "_creationTime"];
        by_root_status: ["rootAssignmentId", "status", "_creationTime"];
        by_parent_delivery: ["actorAssignmentId", "side", "deliveryStatus", "_creationTime"];
        by_join: ["actorAssignmentId", "rootCancellationEpoch", "join", "parentRunId", "_creationTime"];
        by_group: ["parentRunId", "actorAssignmentId", "group", "_creationTime"];
    }, {}, {}>;
}, true>;
export default _default;
