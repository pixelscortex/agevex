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
 * is never attempted twice.
 *
 * If that failure record also cannot commit, no delivery attempt is in flight
 * any more, so ONE more best-effort call records `failed` / `DELIVERY_UNKNOWN`
 * (same token, same pending compare-and-set) and cannot drop a result that
 * would otherwise arrive. Without it the run would stay `pending`, holding one
 * of the parent's cross-request result slots (`canOweResult`) and a hop.
 * `DELIVERY_UNKNOWN` is a separate code because the outcome really is unknown,
 * not a known failure. If this last write throws too it is swallowed: the run
 * stays `pending` and only a cancel (an epoch bump, which the slot guard
 * counts) clears it. Nothing is ever retried.
 */
export declare function deliverTerminalRun(rt: RuntimeContext, ctx: RunnerCtx, runId: string, deliveryToken: string): Promise<void>;
