import { type CoordinatorCtx, type RunnerCtx, type RuntimeContext } from "../registration/context.js";
/**
 * Coordinator `notify` op: load the trusted delivery context for this one-shot
 * capability and attempt delivery. A stale or already-used token loads nothing
 * and is a no-op, which is what makes delivery at-most-once.
 */
export declare function notifyRun(rt: RuntimeContext, ctx: CoordinatorCtx, args: {
    runId: string;
    deliveryToken: string;
}): Promise<null>;
/**
 * Make the single bounded delivery attempt of a settled run.
 *
 * `notify` saves the native parent notification and accepts it into the
 * component queue inside one host transaction, so a throw there rolls both
 * back and leaves the run terminal but undelivered. That outcome is then
 * recorded by a separate metadata-only transition using the same one-shot
 * capability and the same pending-status compare-and-set; the delivery itself
 * is never attempted twice. If even the failure record cannot commit, the run
 * stays honestly `pending` rather than claiming an outcome that was not
 * stored.
 */
export declare function deliverTerminalRun(rt: RuntimeContext, ctx: RunnerCtx, runId: string, deliveryToken: string): Promise<void>;
