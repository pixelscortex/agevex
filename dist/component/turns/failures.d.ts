/** workflows.worker.dispatch: the host action threw, so the slice outcome is unknown. */
export declare const ambiguous: import("convex/server").RegisteredMutation<"public", {
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
/** The slice watchdog fired: the action neither continued nor finished.
 * Detection only: never reassign an expired token or replay a generation. */
export declare const stalled: import("convex/server").RegisteredMutation<"internal", {
    sliceId?: string | undefined;
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
/** The loop workflow failed while this turn was in flight. */
export declare const failWorkflow: import("convex/server").RegisteredMutation<"internal", {
    executionId: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
