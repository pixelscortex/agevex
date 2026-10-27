/** Slice boundaries preserve replay refusal and release only the in-flight bit.
 * Workpool owns crashed-step detection; no scheduled alarm belongs to a slice.
 */
import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** Close a slice without forgetting the id whose paid work must not replay. */
export declare function disarmSlice(ctx: MutationCtx, row: Doc<"assignments">): Promise<void>;
/** The host action finished one slice and will run another: close the slice
 * (the turn stays running). */
export declare function closeSlice(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    executionId: string;
    cancellationEpoch: number;
}): Promise<null>;
/** Phase 1c's seam: all between-slice state checks belong here. Returns the
 * token to run another slice, or null to end the turn workflow (stale,
 * cancelled, a slice that never reached continueTurn, or a cancelled run). */
export declare function admitNextSlice(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    executionId: string;
}): Promise<string | null>;
