/** Workflow journals ids only; host generation owns the in-action deadline. */
export declare const dispatch: import("convex/server").RegisteredAction<"internal", {
    executionId: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    sliceId: string;
}, Promise<null>>;
