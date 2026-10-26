import type { CoordinatorCtx, RuntimeContext } from "../registration/context.js";
import type { CoordinateArgs } from "../types.js";
type SettleArgs = Extract<CoordinateArgs, {
    op: "settle";
}>;
/**
 * Settle one child run with its verified outcome.
 *
 * Settling records the child's outcome only. Delivery is a separate
 * transaction so that a failed delivery can never roll back the
 * truthful child outcome or the counters it already moved.
 *
 * The reported result is authenticated against the native child
 * transcript *before* any terminal state is written, so an invalid,
 * missing, wrong-thread or wrong-agent message id settles as a
 * sanitized failure instead of a completed run. Only the id the component
 * itself recorded for this run (`settlementContext.childResultMessageId`) is
 * ever considered.
 *
 * Returns `deferred` when descendants or the inbox still fence settlement (the
 * outcome is retained and applied later), otherwise `null`.
 */
export declare function settleRun(rt: RuntimeContext, ctx: CoordinatorCtx, args: SettleArgs): Promise<{
    status: "deferred";
    runId: string;
} | null>;
export {};
