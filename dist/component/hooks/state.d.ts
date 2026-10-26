/**
 * Per-turn hook bookkeeping of a running turn.
 *
 * `hookState` (`recordHookState`) stores a beforeTurn model choice on the run
 * and counts completed turns (the hooks' `turn` number and side review
 * cadence). `continueAdmission` (`stageContinuation`) stages an afterTurn
 * continuation prompt as a non-ready inbox row that only the turn's next
 * slice claim consumes, spending one of the run's `continuesPerRun`. Both are
 * fenced to the turn's execution token. Touches `assignments`, `runs` and
 * `inbox`.
 */
import { type MutationCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
/** Record a beforeTurn model choice (validated against the override bounds)
 * and/or count a completed turn. Returns the completed-turn count after this
 * call; throws STALE_TURN for a turn that lost its token. */
export declare function recordHookState(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    executionId: string;
    model?: string;
    complete?: boolean;
}): Promise<number>;
/** Stage an afterTurn continuation prompt for this turn's next slice. Returns
 * the staged inbox row id, or null (no continuation) for a stale turn, a
 * cancelled run or an exhausted allowance. */
export declare function stageContinuation(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    executionId: string;
    prompt: string;
}): Promise<import("convex/values").GenericId<"inbox"> | null>;
/** Record a beforeTurn model choice and/or a completed turn. */
export declare const hookState: import("convex/server").RegisteredMutation<"public", {
    model?: string | undefined;
    complete?: boolean | undefined;
    executionId: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<number>>;
/** Stage an afterTurn hook's continuation prompt for the next slice. */
export declare const continueAdmission: import("convex/server").RegisteredMutation<"public", {
    executionId: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    prompt: string;
}, Promise<import("convex/values").GenericId<"inbox"> | null>>;
