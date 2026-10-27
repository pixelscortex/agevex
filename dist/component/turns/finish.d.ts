import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
type ErrorCode = Doc<"assignments">["errorCode"];
/** End the running turn `turnToken`: success idles the thread and wakes
 * queued work; a failure code is deferred behind the settlement fence
 * (children) or parks the thread in recovery_required. Either way the slice
 * is disarmed first. */
export declare function finishTurn(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    turnToken: string;
    errorCode: ErrorCode;
}): Promise<null>;
/** The slice watchdog fired. Detection only: never reassign an expired
 * token or replay a generation. Escalates only if the watchdog's own slice
 * is still the active one. */
export declare function detectStall(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    turnToken: string;
    sliceId?: string;
}): Promise<null>;
/** Park the assignment for operator recovery with a typed error code. No
 * turn runs again until the host recovers it; wake ignores such rows. */
export declare function markRecoveryRequired(ctx: MutationCtx, row: Doc<"assignments">, code: ErrorCode): Promise<void>;
/** A failed turn also obeys the run fence. A later descendant delivery may
 * continue the run, but this failed paid generation is never retried. Clear its
 * token so any late native writes lose ownership before waking queued work.
 * Returns true when the failure was deferred (the caller must not escalate).
 */
export declare function deferChildFailure(ctx: MutationCtx, row: Doc<"assignments">, code?: ErrorCode): Promise<boolean>;
/** All terminal child failures share the idempotent settlement/notification
 * path (`subagents.settle.escalate`). A no-op for roots. */
export declare function failChild(ctx: MutationCtx, row: Doc<"assignments">, code: ErrorCode): Promise<null>;
/** The dispatch of `turnToken` failed with an unknown outcome (the host action
 * threw, or its workflow failed). Called by `turns.failures.ambiguous` and
 * `turns.failures.failWorkflow`. The token/status fence makes duplicates no-ops; the
 * paid generation is never retried. */
export declare function markAmbiguous(ctx: MutationCtx, assignmentId: Id<"assignments">, turnToken: string): Promise<null>;
export {};
