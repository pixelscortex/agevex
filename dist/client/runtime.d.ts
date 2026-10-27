import type { ComponentApi } from "../component/_generated/component.js";
import { type FileAttachedArgs, type RegisterFileArgs } from "./host/files.js";
import { type NoteArgs, type SandboxCompletion } from "./host/notes.js";
import { type CoordinatorCtx, type RunnerCtx } from "./registration/context.js";
import { type Task, type TaskOptions } from "./tasks.js";
import type { Registration } from "./types.js";
export { ASK_PARENT_TOOL_NAME, DELEGATE_TOOL_NAME, MESSAGE_CHILD_TOOL_NAME, MESSAGE_PARENT_TOOL_NAME, } from "./tool-names.js";
export type { SandboxCompletion };
/**
 * Register one managed, bounded agent graph with the Agevex Convex runtime.
 *
 * The agent instances define native behavior; registration connects their graph
 * to the component, dispatch references, and host authorization policy. Direct
 * native methods remain unmanaged.
 *
 * Throws a typed registration error (see `registration/context.ts`) for any
 * graph, slot or model configuration the runtime cannot execute safely.
 */
export declare function registerAgent(component: ComponentApi, config: Registration): {
    /** Run a structured task outside a turn, reported through the registration's usage slot. */
    runTask: <Input, Output>(ctx: RunnerCtx, task: Task<Input, Output>, input: Input, options?: TaskOptions) => Promise<import("./tasks.js").TaskOutcome<Output>>;
    /** Trusted upload-path helper: bind a stored native file to an authorized subject. */
    registerFile: (ctx: CoordinatorCtx, args: RegisterFileArgs) => Promise<void>;
    /** Exact attachment policy for a host tool's authorize callback. */
    fileAttached: (ctx: Pick<RunnerCtx, "runQuery">, args: FileAttachedArgs) => Promise<boolean>;
    sandboxComplete: (ctx: CoordinatorCtx, event: SandboxCompletion) => Promise<boolean>;
    note: (ctx: CoordinatorCtx, args: NoteArgs) => Promise<boolean>;
    /** The subject-authorized public queries and mutations the host exports. */
    authorizedEndpoints: () => {
        title: import("convex/server").RegisteredQuery<"public", {
            threadId: string;
        }, Promise<{
            text: string | null;
        }>>;
        rename: import("convex/server").RegisteredMutation<"public", {
            threadId: string;
            text: string;
        }, Promise<{
            messageId: string;
            replayed: boolean;
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
            threadId: string;
            text: string;
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
        }, Promise<import("convex/server").PaginationResult<import("./endpoints/reads.js").OriginMessage>>>;
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
            rootRunId?: string | undefined;
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
        }>>;
    };
    /** The host exports these as refs.runTurn, refs.coordinate and refs.textTask. */
    internalFunctions: () => {
        runTurn: import("convex/server").RegisteredAction<"internal", import("./types.js").TurnArgs, null>;
        coordinate: import("convex/server").RegisteredMutation<"internal", import("./types.js").CoordinateArgs, import("./types.js").CoordinateResult>;
        textTask: import("convex/server").RegisteredAction<"internal", {
            kind: "title";
            key: string;
            assignmentId: string;
        }, Promise<null>>;
    };
};
