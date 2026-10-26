import type { PaginationOptions } from "convex/server";
import type { QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** The root context of a running turn that wants to delegate: who the root
 * is and how many children it already has live. Null for stale turns. */
export declare function delegateScope(ctx: QueryCtx, args: {
    assignmentId: Id<"assignments">;
    turnToken: string;
}): Promise<{
    rootAssignmentId: import("convex/values").GenericId<"assignments">;
    rootThreadId: string;
    subject: string;
    rootAgent: string;
    actorAgent: string;
    activeRuns: number;
} | null>;
/**
 * What a finishing child turn needs before it reports its outcome: the run it
 * is finishing, the child's recorded final assistant message (written by
 * turns.slices.write in the same transaction as the native save), and whether the
 * settlement fence still holds (`blocked`: pending inbox work, descendants or
 * an unjoined cohort). The host uses it to verify the result before calling
 * `settle`. Null unless this exact turn token still owns a running child turn
 * whose run is live and attached to it, so a stale or cancelled action can
 * never settle a run it no longer owns.
 */
export declare function settlementScope(ctx: QueryCtx, args: {
    assignmentId: Id<"assignments">;
    turnToken: string;
    runId: string;
}): Promise<{
    runId: string;
    agent: string;
    subject: string;
    childThreadId: string;
    childResultMessageId: string | null;
    blocked: boolean;
} | null>;
export declare const deliveryContextFields: {
    readonly runId: import("convex/values").VString<string, "required">;
    readonly agent: import("convex/values").VString<string, "required">;
    readonly rootAgent: import("convex/values").VString<string, "required">;
    readonly parentAgent: import("convex/values").VString<string, "required">;
    readonly parentThreadId: import("convex/values").VString<string, "required">;
    readonly actorAgent: import("convex/values").VString<string, "required">;
    readonly subject: import("convex/values").VString<string, "required">;
    readonly rootAssignmentId: import("convex/values").VString<string, "required">;
    readonly rootThreadId: import("convex/values").VString<string, "required">;
    readonly childThreadId: import("convex/values").VString<string, "required">;
    readonly childResultMessageId: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    readonly status: import("convex/values").VUnion<"failed" | "completed", [import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">], "required", never>;
    readonly errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
    readonly rootAvailable: import("convex/values").VBoolean<boolean, "required">;
    readonly side: import("convex/values").VBoolean<boolean | undefined, "optional">;
};
/** Everything the coordinator needs to deliver a terminal, undelivered run:
 * the threads and agents on both ends, the verified child result id, and
 * whether the parent side can still accept it (`rootAvailable`). Null when
 * the run is not terminal, already delivered, or its root/parent is gone. */
export declare function terminalContext(ctx: QueryCtx, run: Doc<"subagentRuns">): Promise<{
    runId: string;
    side: boolean | undefined;
    agent: string;
    rootAgent: string;
    parentAgent: string;
    actorAgent: string;
    subject: string;
    rootAssignmentId: import("convex/values").GenericId<"assignments">;
    rootThreadId: string;
    parentThreadId: string;
    childThreadId: string;
    childResultMessageId: string | null;
    status: "failed" | "completed";
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
    rootAvailable: boolean;
} | null>;
/** One page of the root's delegation history, newest first, paginated by
 * the root-wide reservation sequence. */
export declare function delegationPage(ctx: QueryCtx, root: Doc<"assignments">, paginationOpts: PaginationOptions): Promise<{
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
}>;
/** The current root request's tree. Only small coordination fields cross the
 * query boundary; no transcript bodies or execution capabilities are exposed.
 * <=58 model/side launch rows *4 KiB + <=32 KiB root metadata <288 KiB,
 * <64 document reads.
 *
 * A run budget belongs to exactly one root: accept creates it for that root's
 * request, and every descendant inherits it (attach copies the parent run id;
 * every inbox row a descendant can claim carries it), while reserve writes
 * parentRunId = actor.runId with rootAssignmentId = the actor's root. So the
 * parentRunId prefix of by_group is exactly the old (root, run) range. Its size
 * is launches + sideRuns of that budget: only reserve increments either, by
 * one per insert, after refusing at runLaunches / sideRunsPerRun (row.limits,
 * copied from this root and never patched). The take therefore returns every
 * row, and sorting by sequence restores reservation order.
 */
export declare function requestTree(ctx: QueryCtx, root: Doc<"assignments">): Promise<{
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
}[]>;
