/** One paid slice, never retried. Workflow only journals ids, never transcript text. */
export declare const dispatch: import("convex/server").RegisteredAction<"internal", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    executionId: string;
    sliceId: string;
}, Promise<null>>;
