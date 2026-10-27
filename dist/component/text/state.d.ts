export declare const jobArgs: {
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    kind: import("convex/values").VLiteral<"title", "required">;
    key: import("convex/values").VString<string, "required">;
};
export declare const snapshot: import("convex/values").VObject<{
    messageId?: string | undefined;
    modelId?: string | undefined;
    agent: string;
    subject: string;
    threadId: string;
    runId: import("convex/values").GenericId<"runs">;
}, {
    subject: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
    modelId: import("convex/values").VString<string | undefined, "optional">;
    messageId: import("convex/values").VString<string | undefined, "optional">;
}, "required", "agent" | "subject" | "threadId" | "messageId" | "runId" | "modelId">;
/** Preparation cannot be reclaimed by duplicate Workflow/action deliveries. */
export declare const claim: import("convex/server").RegisteredMutation<"public", {
    kind: "title";
    key: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    subject: string;
    agent: string;
    threadId: string;
    runId: import("../_generated/dataModel.js").Id<"runs">;
    modelId: string | undefined;
    messageId: string | undefined;
} | null>>;
/** This is the last admission immediately before provider doGenerate. Only
 * dispatched work has a paid lease; expiry records unknown and never retries. */
export declare const dispatch: import("convex/server").RegisteredMutation<"public", {
    kind: "title";
    key: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<boolean>>;
/** A crash closes the existing receipt; it cannot buy another provider call. */
export declare const expire: import("convex/server").RegisteredMutation<"internal", {
    kind: "title";
    key: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
/** Native updateThread supports title (Agent component/threads.ts:85-106).
 * Reading native title and writing it inside this transaction makes concurrent
 * user/app renames conflict and retry against the new title instead of overwrite. */
export declare const commit: import("convex/server").RegisteredMutation<"public", {
    text?: string | undefined;
    kind: "title";
    status: "failed" | "done" | "unknown";
    key: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<boolean>>;
