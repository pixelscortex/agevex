/** Cancel sets fences before releasing Workflow, which cannot abort actions.
 * See `cancelRoot`. */
export declare const cancel: import("convex/server").RegisteredMutation<"public", {
    subject: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    threadId: string;
    agent: string;
}[]>>;
