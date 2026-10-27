/**
 * Delivering a terminal child's result to its parent thread: `notify`,
 * `deliveryContext`, `deliver` and `failDelivery`.
 *
 * `notify` asks the host coordinator to deliver; the coordinator reads
 * `deliveryContext`, saves the result natively in the parent thread and then
 * calls `deliver` (or `notify` records `failDelivery`). One delivery per run:
 * it records the outcome on the run, spends one hop of the shared budget for
 * accepted results, and enqueues the result as ready parent work or wakes
 * the parent to re-check settlement. Touches `subagentRuns`, `runs`, `inbox`
 * and the parent's counters.
 */
import { type MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
type Delivery = {
    runId: string;
    deliveryToken: string;
    deliveryStatus: "accepted" | "failed" | "blocked";
    parentMessageId: string | null;
    errorCode: Doc<"subagentRuns">["errorCode"];
};
/** Each terminal delivery spends one hop and appends ready work immediately.
 * The delivery token is the capability; a repeated delivery is a no-op. */
export declare function applyDelivery(ctx: MutationCtx, args: Delivery): Promise<null>;
/** The coordinator's view of a terminal run it was notified about. The
 * delivery token proves the caller holds this run's delivery capability. */
export declare const deliveryContext: import("convex/server").RegisteredQuery<"public", {
    runId: string;
    deliveryToken: string;
}, Promise<{
    runId: string;
    agent: string;
    rootAgent: string;
    parentAgent: string;
    actorAgent: string;
    subject: string;
    rootAssignmentId: import("convex/values").GenericId<"assignments">;
    rootThreadId: string;
    parentThreadId: string;
    childThreadId: string;
    childResultMessageId: string | null;
    status: "failed" | "completed";
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
    rootAvailable: boolean;
} | null>>;
/** Ask the host coordinator to deliver a terminal run. If that call fails,
 * record a failed delivery instead (`DELIVERY_UNKNOWN` if that record fails
 * too, see `recordFailure`); the delivery is never retried automatically. */
export declare const notify: import("convex/server").RegisteredAction<"internal", {
    runId: string;
    deliveryToken: string;
    coordinateHandle: string;
}, Promise<null>>;
/** The coordinator's delivery outcome; see `applyDelivery`. */
export declare const deliver: import("convex/server").RegisteredMutation<"public", {
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
    runId: string;
    deliveryStatus: "failed" | "accepted" | "blocked";
    deliveryToken: string;
    parentMessageId: string | null;
}, Promise<null>>;
/** notify's fallback when the coordinator itself failed. `unknown` records
 * `DELIVERY_UNKNOWN` instead, for the case where this record also threw. */
export declare const failDelivery: import("convex/server").RegisteredMutation<"internal", {
    unknown?: boolean | undefined;
    runId: string;
    deliveryToken: string;
}, Promise<null>>;
export {};
