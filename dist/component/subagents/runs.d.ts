/**
 * Lookups and the row builder for the `subagentRuns` table.
 *
 * One row per delegation: the child linkage, the root epoch it was admitted
 * under, its wait-"all" join state, its verified result reference, delivery
 * capability and a bounded event history. `subagents.launch.reserve` inserts it;
 * settlement, delivery and group release (subagents/*) move it forward;
 * `turns.cancel.cancel` fails every live one. All reads here are exact indexed
 * lookups; no history prefix is ever read.
 */
import type { WithoutSystemFields } from "convex/server";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
type SubagentRun = Doc<"subagentRuns">;
/** The run with this public run id (unique `by_run` index), or null. */
export declare function runById(ctx: QueryCtx | MutationCtx, runId: string): Promise<{
    _id: import("convex/values").GenericId<"subagentRuns">;
    _creationTime: number;
    join?: "open" | "sealed" | "ready" | "joined" | undefined;
    startedAt?: number | undefined;
    taskMessageId?: string | undefined;
    taskPreview?: string | undefined;
    resultMessageId?: string | undefined;
    side?: boolean | undefined;
    group?: string | undefined;
    questionMessageId?: string | undefined;
    lastParentNoteAt?: number | undefined;
    childAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
    childThreadId?: string | undefined;
    childResultMessageId?: string | undefined;
    lastTurnResult?: {
        messageId?: string | undefined;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
    } | undefined;
    resultSequence?: number | undefined;
    events: {
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
        at: number;
        phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
    }[];
    status: "failed" | "running" | "completed" | "queued" | "asking";
    agent: string;
    sequence: number;
    runId: string;
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
    rootAssignmentId: import("convex/values").GenericId<"assignments">;
    rootCancellationEpoch: number;
    deliveryStatus: "failed" | "pending" | "accepted" | "blocked";
    parentRunId: import("convex/values").GenericId<"runs">;
    dedupKey: string;
    payloadFingerprint: string;
    actorAssignmentId: import("convex/values").GenericId<"assignments">;
    depth: number;
    messagesReceived: number;
    parentNotesSent: number;
    actorAgent: string;
    deliveryToken: string;
    coordinateHandle: string;
    createdAt: number;
} | null>;
/** True once a run reached a terminal status. Delivery may still be pending. */
export declare function isSettled(status: SubagentRun["status"]): status is "failed" | "completed";
/** Append one transition, keeping only the newest `LIMITS.runEvents` so every
 * run row stays inside its <=4 KiB envelope (limits.ts cancel budget). Every
 * writer of `events` goes through here (reserve's first "queued" aside). */
export declare function appendEvent(events: SubagentRun["events"], phase: SubagentRun["events"][number]["phase"], at: number, errorCode: SubagentRun["errorCode"]): {
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
    at: number;
    phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
}[];
/** The public `finishedAt` / `deliveryAt` of a run, derived from its event
 * ring rather than stored a second time.
 *
 * Why the ring always holds both events: settleRunState and cancel are the
 * only terminal transitions and each refuses a run that is already terminal,
 * so a run has exactly one terminal event (completed/failed). Claim appends
 * "started" only while the run is queued or running, and applyDelivery
 * appends at most one delivery event, only to a terminal run whose delivery
 * is still pending. So at most one delivery event ever follows the terminal
 * event: both are among the newest two entries, inside the
 * `LIMITS.runEvents` (4) ring however many turns the child ran. Cancel marks
 * delivery `blocked` without a delivery event, in the same transaction as its
 * terminal event, so that event's time is also the delivery time. */
export declare function runTimes(run: Pick<SubagentRun, "events" | "deliveryStatus">): {
    finishedAt: number | null;
    deliveryAt: number | null;
};
/** One wait cohort: the members a parent launched under one run budget and
 * group name, in creation order (`by_group` pins all three fields). Callers
 * pass the cohort cap, so the read never exceeds <=15 rows (<=60 KiB). */
export declare function groupMembers(ctx: QueryCtx | MutationCtx, cohort: {
    parentRunId: Id<"runs">;
    actorAssignmentId: Id<"assignments">;
    group: string;
}, limit: number): Promise<{
    _id: import("convex/values").GenericId<"subagentRuns">;
    _creationTime: number;
    join?: "open" | "sealed" | "ready" | "joined" | undefined;
    startedAt?: number | undefined;
    taskMessageId?: string | undefined;
    taskPreview?: string | undefined;
    resultMessageId?: string | undefined;
    side?: boolean | undefined;
    group?: string | undefined;
    questionMessageId?: string | undefined;
    lastParentNoteAt?: number | undefined;
    childAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
    childThreadId?: string | undefined;
    childResultMessageId?: string | undefined;
    lastTurnResult?: {
        messageId?: string | undefined;
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
    } | undefined;
    resultSequence?: number | undefined;
    events: {
        errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
        at: number;
        phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
    }[];
    status: "failed" | "running" | "completed" | "queued" | "asking";
    agent: string;
    sequence: number;
    runId: string;
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
    rootAssignmentId: import("convex/values").GenericId<"assignments">;
    rootCancellationEpoch: number;
    deliveryStatus: "failed" | "pending" | "accepted" | "blocked";
    parentRunId: import("convex/values").GenericId<"runs">;
    dedupKey: string;
    payloadFingerprint: string;
    actorAssignmentId: import("convex/values").GenericId<"assignments">;
    depth: number;
    messagesReceived: number;
    parentNotesSent: number;
    actorAgent: string;
    deliveryToken: string;
    coordinateHandle: string;
    createdAt: number;
}[]>;
/** The queued row `subagents.launch.reserve` inserts once admission passed. The
 * native child thread does not exist yet; `attach` adds the child linkage.
 * `wait: "all"` members start in the "open" join state, which the launching
 * slice's sealGroups later closes. */
export declare function newSubagentRun(fields: {
    /** The caller's reserve arguments: target agent, payload hash, coordinator. */
    request: {
        side?: boolean;
        agent: string;
        payloadFingerprint: string;
        coordinateHandle: string;
    };
    runId: string;
    actor: Doc<"assignments">;
    root: Doc<"assignments">;
    budget: Doc<"runs">;
    depth: number;
    group: string | undefined;
    wait: "each" | "all";
    dedupKey: string;
    sequence: number;
    now: number;
}): WithoutSystemFields<SubagentRun>;
/** Leave 1 KiB for native id/time, future result/question refs, four events,
 * timestamps, note counters and the deferred last-turn outcome. Check again
 * at task attachment so preview growth cannot break the 4 KiB read budget.
 */
export declare function assertRunMetadata(row: WithoutSystemFields<SubagentRun>): void;
export {};
