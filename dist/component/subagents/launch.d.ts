/**
 * Launching a delegation: the trusted `delegateContext` of a running turn,
 * admission (`reserve`) and attaching the native child thread (`attach`).
 *
 * `reserveRun` checks, in order: the turn still owns its token, root and
 * parent run are live in the current epoch, depth and group arguments are
 * valid, the tool call was not already reserved (idempotent replay), the root
 * has a free active slot, the run budget has a launch/hop (or side-run) left,
 * the assignment has outstanding-result headroom across requests, and the named
 * cohort accepts another member. Success spends the budget and
 * inserts the queued run in the same transaction as the host's native
 * child-thread creation. `attachChild` then creates the child assignment with
 * its task as the first inbox row and wakes it. Touches `subagentRuns`,
 * `runs`, `assignments`, `inbox` and the root's delegation counters.
 */
import { type ObjectType } from "convex/values";
import { type MutationCtx } from "../_generated/server.js";
export declare const reserveArgs: {
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    turnToken: import("convex/values").VString<string, "required">;
    toolCallId: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
    payloadFingerprint: import("convex/values").VString<string, "required">;
    coordinateHandle: import("convex/values").VString<string, "required">;
    side: import("convex/values").VBoolean<boolean | undefined, "optional">;
    group: import("convex/values").VString<string | undefined, "optional">;
    wait: import("convex/values").VUnion<"each" | "all" | undefined, [import("convex/values").VLiteral<"each", "required">, import("convex/values").VLiteral<"all", "required">], "optional", never>;
};
export declare const reservation: import("convex/values").VUnion<{
    kind: "reserved";
    runId: string;
} | {
    kind: "replay";
    agent: string;
    runId: string;
} | {
    kind: "denied";
    code: "HOOK_BLOCKED" | "ACTIVE_LIMIT" | "TASK_LIMIT" | "FORBIDDEN" | "STALE_TURN" | "DELEGATION_CONFLICT" | "RUN_BUDGET" | "DEPTH_LIMIT" | "GROUP_LIMIT" | "GROUP_CLOSED" | "GROUP_CONFLICT" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "MESSAGE_TOO_LARGE" | "MESSAGE_EMPTY" | "SIDE_RUN" | "MESSAGE_RATE_LIMIT" | "KEY_CONFLICT" | "NO_PARENT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT";
}, [import("convex/values").VObject<{
    kind: "reserved";
    runId: string;
}, {
    kind: import("convex/values").VLiteral<"reserved", "required">;
    runId: import("convex/values").VString<string, "required">;
}, "required", "kind" | "runId">, import("convex/values").VObject<{
    kind: "replay";
    agent: string;
    runId: string;
}, {
    kind: import("convex/values").VLiteral<"replay", "required">;
    runId: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
}, "required", "kind" | "agent" | "runId">, import("convex/values").VObject<{
    kind: "denied";
    code: "HOOK_BLOCKED" | "ACTIVE_LIMIT" | "TASK_LIMIT" | "FORBIDDEN" | "STALE_TURN" | "DELEGATION_CONFLICT" | "RUN_BUDGET" | "DEPTH_LIMIT" | "GROUP_LIMIT" | "GROUP_CLOSED" | "GROUP_CONFLICT" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "MESSAGE_TOO_LARGE" | "MESSAGE_EMPTY" | "SIDE_RUN" | "MESSAGE_RATE_LIMIT" | "KEY_CONFLICT" | "NO_PARENT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT";
}, {
    kind: import("convex/values").VLiteral<"denied", "required">;
    code: import("convex/values").VUnion<"HOOK_BLOCKED" | "ACTIVE_LIMIT" | "TASK_LIMIT" | "FORBIDDEN" | "STALE_TURN" | "DELEGATION_CONFLICT" | "RUN_BUDGET" | "DEPTH_LIMIT" | "GROUP_LIMIT" | "GROUP_CLOSED" | "GROUP_CONFLICT" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "MESSAGE_TOO_LARGE" | "MESSAGE_EMPTY" | "SIDE_RUN" | "MESSAGE_RATE_LIMIT" | "KEY_CONFLICT" | "NO_PARENT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT", [import("convex/values").VLiteral<"HOOK_BLOCKED", "required">, import("convex/values").VLiteral<"ACTIVE_LIMIT", "required">, import("convex/values").VLiteral<"TASK_LIMIT", "required">, import("convex/values").VLiteral<"FORBIDDEN", "required">, import("convex/values").VLiteral<"STALE_TURN", "required">, import("convex/values").VLiteral<"DELEGATION_CONFLICT", "required">, import("convex/values").VLiteral<"RUN_BUDGET", "required">, import("convex/values").VLiteral<"DEPTH_LIMIT", "required">, import("convex/values").VLiteral<"GROUP_LIMIT", "required">, import("convex/values").VLiteral<"GROUP_CLOSED", "required">, import("convex/values").VLiteral<"GROUP_CONFLICT", "required">, import("convex/values").VLiteral<"CHILD_FINISHED", "required">, import("convex/values").VLiteral<"MESSAGE_LIMIT", "required">, import("convex/values").VLiteral<"MESSAGE_TOO_LARGE", "required">, import("convex/values").VLiteral<"MESSAGE_EMPTY", "required">, import("convex/values").VLiteral<"SIDE_RUN", "required">, import("convex/values").VLiteral<"MESSAGE_RATE_LIMIT", "required">, import("convex/values").VLiteral<"KEY_CONFLICT", "required">, import("convex/values").VLiteral<"NO_PARENT", "required">, import("convex/values").VLiteral<"ASK_PENDING", "required">, import("convex/values").VLiteral<"ASK_WITH_CHILDREN", "required">, import("convex/values").VLiteral<"QUEUE_LIMIT", "required">], "required", never>;
}, "required", "kind" | "code">], "required", "kind" | "agent" | "runId" | "code">;
type ReserveArgs = ObjectType<typeof reserveArgs>;
/**
 * Reservation, run-budget spend and active-child count commit with the host's
 * native child thread creation. Dedup precedes admission limits so a repeated
 * callback can recover its original receipt even at capacity. Result turns
 * retain the originating user run; only a new user prompt creates new budget.
 * Root counters include every descendant. Depth is checked from the immediate
 * parent run, so a shared child definition cannot bypass the configured bound.
 */
export declare function reserveRun(ctx: MutationCtx, args: ReserveArgs): Promise<{
    kind: "denied";
    code: "RUN_BUDGET";
} | {
    kind: "denied";
    code: "STALE_TURN";
} | {
    kind: "denied";
    code: "FORBIDDEN";
} | {
    kind: "denied";
    code: "DEPTH_LIMIT";
} | {
    kind: "denied";
    code: "GROUP_CONFLICT";
} | {
    kind: "denied";
    code: "TASK_LIMIT";
} | {
    kind: "denied";
    code: "DELEGATION_CONFLICT";
} | {
    kind: "denied";
    code: "ACTIVE_LIMIT";
} | {
    kind: "denied";
    code: "GROUP_CLOSED";
} | {
    kind: "denied";
    code: "GROUP_LIMIT";
} | {
    kind: "replay";
    runId: string;
    agent: string;
} | {
    kind: "reserved";
    runId: `${string}-${string}-${string}-${string}-${string}`;
    agent?: undefined;
}>;
export declare const attachArgs: {
    runId: import("convex/values").VString<string, "required">;
    childThreadId: import("convex/values").VString<string, "required">;
    promptMessageId: import("convex/values").VString<string, "required">;
    savedMessage: import("convex/values").VObject<{
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
    trackContext: import("convex/values").VBoolean<boolean | undefined, "optional">;
};
/**
 * Queue a native child in its independent lane. Keeping the task in Agent and
 * only the message id in the inbox avoids placing task bodies in Workflow's
 * 800 KiB step values. The parent's short launch mutation never waits for a
 * child action, leaving scheduler capacity available for those children.
 * Idempotent: an already attached run is a no-op.
 */
export declare function attachChild(ctx: MutationCtx, args: ObjectType<typeof attachArgs>): Promise<null>;
/** Trusted root context for a running turn that wants to delegate. */
export declare const delegateContext: import("convex/server").RegisteredQuery<"public", {
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    rootAssignmentId: import("convex/values").GenericId<"assignments">;
    rootThreadId: string;
    subject: string;
    rootAgent: string;
    actorAgent: string;
    activeRuns: number;
} | null>>;
/** Admit one delegation and spend its budget; see `reserveRun`. */
export declare const reserve: import("convex/server").RegisteredMutation<"public", {
    side?: boolean | undefined;
    group?: string | undefined;
    wait?: "each" | "all" | undefined;
    agent: string;
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    toolCallId: string;
    payloadFingerprint: string;
    coordinateHandle: string;
}, Promise<{
    kind: "denied";
    code: "RUN_BUDGET";
} | {
    kind: "denied";
    code: "STALE_TURN";
} | {
    kind: "denied";
    code: "FORBIDDEN";
} | {
    kind: "denied";
    code: "DEPTH_LIMIT";
} | {
    kind: "denied";
    code: "GROUP_CONFLICT";
} | {
    kind: "denied";
    code: "TASK_LIMIT";
} | {
    kind: "denied";
    code: "DELEGATION_CONFLICT";
} | {
    kind: "denied";
    code: "ACTIVE_LIMIT";
} | {
    kind: "denied";
    code: "GROUP_CLOSED";
} | {
    kind: "denied";
    code: "GROUP_LIMIT";
} | {
    kind: "replay";
    runId: string;
    agent: string;
} | {
    kind: "reserved";
    runId: `${string}-${string}-${string}-${string}-${string}`;
    agent?: undefined;
}>>;
/** Create the child assignment for a reserved run's native thread and queue
 * its task; see `attachChild`. */
export declare const attach: import("convex/server").RegisteredMutation<"public", {
    savedMessage?: {
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
    } | undefined;
    trackContext?: boolean | undefined;
    runId: string;
    promptMessageId: string;
    childThreadId: string;
}, Promise<null>>;
export {};
