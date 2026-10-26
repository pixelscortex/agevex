/**
 * Model routing ownership for `beforeTurn` hooks.
 *
 * The first claimed slice of an agent in a run may own the run's routing bit
 * (`runs.routingAgents`) while its hook chooses a model; sibling turns of the
 * same agent wait (`routing`) and then read the decided model. Ownership is
 * recorded on the owning assignment (`routingAgentIndex`) so every terminal
 * fence can release it without scanning siblings. Acquisition itself is
 * inline in turns/claim.ts, which only calls `assertAgentIndex` from here;
 * the owner releases with `completeRouting`, and turns/boundaries.ts
 * (`disarmSlice`) releases on every slice end. Touches `runs` and
 * `assignments.routingAgentIndex`.
 */
import { type MutationCtx, type QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** Agent indexes address bits of the 64-bit run masks; reject anything else
 * before shifting a BigInt by it. */
export declare function assertAgentIndex(agentIndex: number): void;
/** The first claimed slice owns one routing attempt, never a retry. A terminal
 * owner keeps startedAgents set and releases routingAgents; waiting siblings
 * use the last committed run model, or their default if no decision committed.
 * Ownership lives on that assignment so watchdog/cancel can settle it without
 * scanning siblings or trusting a failed action to run cleanup. <=3 metadata
 * reads (get run, read run for patch, read assignment for patch) and <=2 writes:
 * (16+16+32)=64 KiB read per owner, included in limits.ts's cancel budget. No
 * native content is accessed.
 */
export declare function settleRouting(ctx: MutationCtx, row: Doc<"assignments">): Promise<void>;
/** Whether another turn of this agent still owns the run's routing decision,
 * and the run's current model for the agent. Null for cancelled work. */
export declare function routingState(ctx: QueryCtx, args: {
    assignmentId: Id<"assignments">;
    agentIndex: number;
}): Promise<{
    pending: boolean;
    modelId: string | undefined;
} | null>;
/** The routing owner finished its beforeTurn decision: release the bit if
 * this turn still owns it. */
export declare function completeRoutingFor(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    executionId: string;
    agentIndex: number;
}): Promise<null>;
/** Whether the run's routing decision for this agent is still pending. */
export declare const routing: import("convex/server").RegisteredQuery<"public", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    agentIndex: number;
}, Promise<{
    pending: boolean;
    modelId: string | undefined;
} | null>>;
/** The routing owner finished its decision: release routing ownership. */
export declare const completeRouting: import("convex/server").RegisteredMutation<"public", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    executionId: string;
    agentIndex: number;
}, Promise<null>>;
