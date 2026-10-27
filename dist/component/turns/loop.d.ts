/** Workflow ownership fences old loops after cancellation and rotation. */
export declare const next: import("convex/server").RegisteredMutation<"internal", {
    workflowId: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<import("./wake.js").NextTurn>>;
