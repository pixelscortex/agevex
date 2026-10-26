import { type UIMessage } from "@convex-dev/agent";
import { type PaginationResult } from "convex/server";
import { type EndpointContext } from "./access.js";
export type OriginMessage = UIMessage & {
    origin: "user" | "result" | "note" | "continue";
    from?: string;
    runId?: string;
};
/** `messages`: one origin-labelled page of the thread's native transcript. */
export declare function messagesEndpoint(ep: EndpointContext): import("convex/server").RegisteredQuery<"public", {
    paginationOpts: {
        id?: number;
        endCursor?: string | null;
        maximumRowsRead?: number;
        maximumBytesRead?: number;
        numItems: number;
        cursor: string | null;
    };
    threadId: string;
}, Promise<PaginationResult<OriginMessage>>>;
/** `streams`: native stream sync for the thread, with bounded cursors. */
export declare function streamsEndpoint(ep: EndpointContext): import("convex/server").RegisteredQuery<"public", {
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
/** `activity`: the owned root thread's current queue activity. */
export declare function activityEndpoint(ep: EndpointContext): import("convex/server").RegisteredQuery<"public", {
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
/** Return the current request's full delegation tree after root ownership authorization. */
export declare function runTreeEndpoint(ep: EndpointContext): import("convex/server").RegisteredQuery<"public", {
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
/**
 * Newest-first page of one root's delegated child runs.
 *
 * Authorized exactly like the other subject-owned coordination reads, using
 * the existing `activity` operation: it is a projection of the same
 * thread's coordination state, and the frozen authorization scope has no
 * separate delegation-read variant. Ownership is therefore established by the
 * host policy first and re-checked against the persisted subject by the
 * component query.
 *
 * Returns coordination records with the child's native thread id once it
 * exists, so its owner can read that conversation through `messages`.
 * Execution and delivery tokens stay private. The delivered result in the
 * native parent transcript remains reachable through `resultMessageId`.
 */
export declare function delegationsEndpoint(ep: EndpointContext): import("convex/server").RegisteredQuery<"public", {
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
