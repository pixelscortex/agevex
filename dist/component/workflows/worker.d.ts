/** One paid slice, never retried. Workflow only journals ids, never transcript text. */
export declare const dispatch: import("convex/server").RegisteredAction<"internal", {
    executionId: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    sliceId: string;
}, Promise<null>>;
