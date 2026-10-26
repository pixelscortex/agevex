import { type MutationCtx, type QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** Every non-terminal child retains deliveryStatus=pending; delivery can only
 * change after settlement. One indexed existence probe therefore covers live
 * descendants AND the terminal-to-delivery gap. The fence is transitive because
 * a child obeys the same rule before settling. No history scan is needed.
 */
export declare function hasPendingChildren(ctx: QueryCtx | MutationCtx, parent: Doc<"assignments">, includeSide?: boolean): Promise<boolean>;
/** A terminal child whose native delivery has not committed is also future
 * inbox work. Fence that short settlement/delivery interval and unreleased
 * groups as well as live descendants; otherwise a result could reach a terminal
 * parent. Five indexed existence probes (<=3 KiB inbox + 4*4 KiB runs)
 * + one <=34 KiB root
 * read total <=53 KiB; no history is read.
 */
export declare function settlementBlocked(ctx: QueryCtx | MutationCtx, parent: Doc<"assignments">): Promise<boolean>;
/** Move a live run to its terminal status if its child is not fenced, release
 * the root's active slot, and re-check R3 on the ordinary parent. Returns
 * false (writing nothing) when already terminal or still blocked;
 * `settleIdleParent` and escalate rely on that to notify exactly once
 * (`recordTurnOutcome` ignores it: its settle only records the outcome). */
export declare function settleRunState(ctx: MutationCtx, run: Doc<"subagentRuns">, status: "completed" | "failed", errorCode: Doc<"subagentRuns">["errorCode"], childResultMessageId: string | undefined): Promise<boolean>;
/** Schedule the host coordinator's delivery of a newly terminal run. The
 * notify action runs outside this transaction and records a failed delivery
 * if the coordinator throws. */
export declare function scheduleNotify(ctx: MutationCtx, run: Doc<"subagentRuns">): Promise<void>;
/** R3 is an invariant, not just a turn-end check. Delivery failure and an
 * empty join can remove the last blocker without creating another turn. Use
 * only the host-verified outcome recorded by settle; a native save alone is
 * not proof that the last turn reported a valid result. The same notification
 * path propagates the terminal outcome to the next ancestor without paid work.
 * Depth <=2 bounds propagation to at most 2 * (6*34 KiB assignment reads +
 * 2*4 KiB run reads + 19 KiB indexed fence probes) <=462 KiB metadata,
 * including patch reads and the watched thread's context references. No native
 * bodies are read here; side settlement never enters this ancestor path.
 * Returns true when the child's run is (now) terminal.
 */
export declare function settleIdleParent(ctx: MutationCtx, parent: Doc<"assignments">): Promise<boolean>;
/** `subagents.settle.settle`: record the host-verified outcome of a child's turn and
 * settle its run if nothing fences settlement. A fenced outcome waits on the
 * run (R3 settles it later from `lastTurnResult`). Only the turn that owns
 * the token may report; anything else is FORBIDDEN. */
export declare function recordTurnOutcome(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    turnToken: string;
    runId: string;
    childResultMessageId: string | null;
    errorCode: Doc<"subagentRuns">["errorCode"];
}): Promise<null>;
/** `subagents.settle.escalate`: fail a live run after its child turn failed
 * terminally (turns/finish.ts failChild). Records the failure as the
 * last-turn outcome first, so a fenced run still fails once its blockers
 * clear; notifies only on the first successful settlement. */
export declare function escalateRun(ctx: MutationCtx, runId: string, code: Doc<"subagentRuns">["errorCode"] | undefined): Promise<null>;
/** What a finishing child turn needs to verify and report its result: the
 * run, its recorded final message id and whether settlement is still fenced.
 * Null unless this exact token owns the running child turn of a live run;
 * see `settlementScope` in subagents/views.ts. */
export declare const settlementContext: import("convex/server").RegisteredQuery<"public", {
    runId: string;
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    runId: string;
    agent: string;
    subject: string;
    childThreadId: string;
    childResultMessageId: string | null;
    blocked: boolean;
} | null>>;
/** Record a child turn's host-verified outcome and settle its run when
 * nothing fences it; see `recordTurnOutcome`. */
export declare const settle: import("convex/server").RegisteredMutation<"public", {
    runId: string;
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
    turnToken: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    childResultMessageId: string | null;
}, Promise<null>>;
/** Fail a live run after its child turn failed terminally. */
export declare const escalate: import("convex/server").RegisteredMutation<"internal", {
    errorCode?: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null | undefined;
    runId: string;
}, Promise<null>>;
