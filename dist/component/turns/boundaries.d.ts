/**
 * Slice boundaries of a running turn.
 *
 * A turn runs as up to `slicesPerTurn` paid model slices. claim arms a
 * watchdog per slice; `disarmSlice` closes it (also on every terminal path).
 * A running turn without a watchdog is "between slices": `closeSlice`
 * (`turns.slices.continueTurn`) puts it there and publishes results released by the
 * slice, and `admitNextSlice` (`turns.slices.betweenSlices`) lets the turn workflow
 * run another slice while the run budget allows. Touches `assignments`,
 * `runs` (budget read).
 */
import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** Close the in-flight slice: retire its
 * watchdog. Leaves `turnStatus` alone, so a running turn without a watchdog
 * reads as "between slices". */
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
