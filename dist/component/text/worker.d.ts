export declare const work: import("convex/server").RegisteredMutation<"internal", import("@convex-dev/workflow").WorkflowArgs<{
    handle: import("convex/values").VString<string, "required">;
    assignmentId: import("convex/values").VString<string, "required">;
    kind: import("convex/values").VUnion<"title" | "summary", [import("convex/values").VLiteral<"title", "required">, import("convex/values").VLiteral<"summary", "required">], "required", never>;
    key: import("convex/values").VString<string, "required">;
}>, import("@convex-dev/workflow").WorkflowMutationResult<null>>;
/** A crashed action is never retried. Its paid claim's finite expiry records
 * unknown status; cleanup only removes Workflow bookkeeping. */
export declare const done: import("convex/server").RegisteredMutation<"internal", {
    workflowId: string;
    result: {
        kind: "success";
        returnValue: any;
    } | {
        kind: "failed";
        error: string;
    } | {
        kind: "canceled";
    };
    context: {
        kind: "title" | "summary";
        key: string;
        assignmentId: import("convex/values").GenericId<"assignments">;
    };
}, Promise<null>>;
