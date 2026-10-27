import { type MutationCtx, type QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
/** Every non-terminal child retains deliveryStatus=pending; delivery can only
 * change after settlement. One indexed existence probe therefore covers live
 * descendants AND the terminal-to-delivery gap. The fence is transitive because
 * a child obeys the same rule before settling. No history scan is needed.
 */
export declare function hasPendingChildren(ctx: QueryCtx | MutationCtx, parent: Doc<"assignments">): Promise<boolean>;
/** A pending native delivery is future inbox work and fences settlement just
 * like a live descendant. Two indexed probes read <=3 KiB inbox +4 KiB run;
 * no historical prefix or native message bodies are read.
 */
export declare function settlementBlocked(ctx: QueryCtx | MutationCtx, parent: Doc<"assignments">): Promise<boolean>;
/** R3 is an invariant, not just a turn-end check. Delivery failure and an
 * blocked delivery can remove the last blocker without creating another turn. Use
 * only the host-verified outcome recorded by settle; a native save alone is
 * not proof that the last turn reported a valid result. The same notification
 * path propagates the terminal outcome to the next ancestor without paid work.
 * Depth <=2 bounds propagation to at most 2 * (6*16 KiB assignment reads +
 * 2*4 KiB run reads +7 KiB indexed fence probes) <=222 KiB metadata,
 * including patch reads. No native
 * bodies are read here.
 * Returns true when the child's run is (now) terminal.
 */
export declare function settleIdleParent(ctx: MutationCtx, parent: Doc<"assignments">): Promise<boolean>;
/** What a finishing child turn needs to verify and report its result: the
 * run, its recorded final message id and whether settlement is still fenced.
 * Null unless this exact token owns the running child turn of a live run;
 * see `settlementScope` in subagents/views.ts. */
export declare const settlementContext: import("convex/server").RegisteredQuery<"public", {
    runId: string;
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    runId: import("convex/values").GenericId<"subagentRuns">;
    agent: string;
    subject: string;
    childThreadId: string;
    childResultMessageId: string | null;
    blocked: boolean;
} | null>>;
/** Record a child turn's host-verified outcome and settle its run when
 * nothing fences it; see `recordTurnOutcome`. */
export declare const settle: import("convex/server").RegisteredMutation<"public", {
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
    runId: string;
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    childResultMessageId: string | null;
}, Promise<null>>;
/** Fail a live run after its child turn failed terminally. */
export declare const escalate: import("convex/server").RegisteredMutation<"internal", {
    errorCode?: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null | undefined;
    runId: string;
}, Promise<null>>;
