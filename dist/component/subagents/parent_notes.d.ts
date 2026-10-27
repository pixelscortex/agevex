/** Check encoded text size before native saving, including JSON escaping overhead. */
export declare function parentNoteFits(text: string): boolean;
/** Trusted native-save target or a replay/denial; fresh limits precede every save. */
export declare const parentNoteContext: import("convex/server").RegisteredQuery<"public", {
    key: string;
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    text: string;
    fingerprint: string;
}, Promise<{
    kind: "denied";
    code: "FORBIDDEN" | "STALE_TURN" | "RUN_BUDGET" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "MESSAGE_RATE_LIMIT" | "NO_PARENT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT";
} | {
    kind: "ready";
    runId: string;
    agent: string;
    subject: string;
    childThreadId: string;
    parentThreadId: string;
    rootThreadId: string;
    rootAssignmentId: import("convex/values").GenericId<"assignments">;
    rootAgent: string;
    actorAgent: string;
    parentAgent: string;
} | {
    kind: "denied";
    code: "MESSAGE_EMPTY";
    messageId?: undefined;
} | {
    kind: "denied";
    code: "MESSAGE_TOO_LARGE";
    messageId?: undefined;
} | {
    kind: "denied";
    code: "KEY_CONFLICT";
    messageId?: undefined;
} | {
    kind: "replay";
    messageId: string;
    code?: undefined;
}>>;
/** Record the exact native id and receipt with queue publication in the host transaction. */
export declare const messageParent: import("convex/server").RegisteredMutation<"public", {
    key: string;
    messageId: string;
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    text: string;
    fingerprint: string;
}, Promise<{
    status: "accepted";
    messageId: string;
}>>;
