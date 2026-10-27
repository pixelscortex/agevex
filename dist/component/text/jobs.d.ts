/** One non-retried background job per receipt key. Temporary metadata contains
 * only native identities; title text belongs to the Agent thread. */
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
export type TextJob = {
    runId: Id<"runs">;
    messageId?: string;
    phase: "queued" | "preparing" | "dispatched";
};
export declare const textScope: (assignmentId: Id<"assignments">) => string;
/** The title caller runs only at first acceptance;
 * neither failure nor lease expiry ever schedules another paid attempt. */
export declare function queueText(ctx: MutationCtx, row: Doc<"assignments">, runId: Id<"runs">, messageId?: string): Promise<boolean>;
