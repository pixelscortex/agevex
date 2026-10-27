/** Duplicate, cancelled and superseded completions cannot touch a new turn. */
export declare const failWorkflow: import("convex/server").RegisteredMutation<"internal", {
    workflowId: string;
    executionId: string;
    epoch: number;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
