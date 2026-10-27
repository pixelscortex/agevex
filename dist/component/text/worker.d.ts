export declare const work: import("convex/server").RegisteredMutation<"internal", import("@convex-dev/workflow").WorkflowArgs<{
    handle: import("convex/values").VString<string, "required">;
    assignmentId: import("convex/values").VString<string, "required">;
}>, import("@convex-dev/workflow").WorkflowMutationResult<null>>;
/** Preparation failure is known; a crashed dispatched action is unknown.
 * Successful workers already closed their receipt in the native-write mutation. */
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
        assignmentId: import("convex/values").GenericId<"assignments">;
    };
}, Promise<null>>;
