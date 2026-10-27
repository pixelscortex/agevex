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
    code: "DELEGATION_CONFLICT";
} | {
    kind: "denied";
    code: "ACTIVE_LIMIT";
} | {
    kind: "denied";
    code: "RESULTS_PENDING";
} | {
    kind: "replay";
    runId: import("convex/values").GenericId<"subagentRuns">;
    agent: string;
} | {
    kind: "reserved";
    runId: import("convex/values").GenericId<"subagentRuns">;
    agent?: undefined;
}>>;
/** Create the child assignment for a reserved run's native thread and queue
 * its task; see `attachChild`. */
export declare const attach: import("convex/server").RegisteredMutation<"public", {
    runId: string;
    promptMessageId: string;
    childThreadId: string;
}, Promise<null>>;
