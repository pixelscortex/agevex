import { type MutationCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
/** Cancel the root thread owned by `subject` and all its live descendants.
 * Returns the affected native threads so the host can abort their streams. */
export declare function cancelRoot(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    subject: string;
}): Promise<{
    threadId: string;
    agent: string;
}[]>;
/** Cancel sets fences before canceling Workflow, which cannot abort actions.
 * See `cancelRoot`. */
export declare const cancel: import("convex/server").RegisteredMutation<"public", {
    subject: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    threadId: string;
    agent: string;
}[]>>;
