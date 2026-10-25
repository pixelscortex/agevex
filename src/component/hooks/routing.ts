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
import { type MutationCtx, type QueryCtx, mutation, query } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";
import { v } from "convex/values";

/** Agent indexes address bits of the 64-bit run masks; reject anything else
 * before shifting a BigInt by it. */
export function assertAgentIndex(agentIndex: number) {
  if (!Number.isSafeInteger(agentIndex) || agentIndex < 0 || agentIndex >= LIMITS.agents)
    throw new Error("INVALID_AGENT_INDEX");
}

/** The first claimed slice owns one routing attempt, never a retry. A terminal
 * owner keeps startedAgents set and releases routingAgents; waiting siblings
 * use the last committed run model, or their default if no decision committed.
 * Ownership lives on that assignment so watchdog/cancel can settle it without
 * scanning siblings or trusting a failed action to run cleanup. <=3 metadata
 * reads (get run, read run for patch, read assignment for patch) and <=2 writes:
 * (1+1+32)=34 KiB read per owner, included in limits.ts's cancel budget. No
 * native content is accessed.
 */
export async function settleRouting(ctx: MutationCtx, row: Doc<"assignments">) {
  if (row.routingAgentIndex === undefined || !row.runId) return;

  const run = await ctx.db.get("runs", row.runId);
  if (run)
    await ctx.db.patch("runs", run._id, {
      routingAgents: BigInt.asIntN(
        LIMITS.agents,
        run.routingAgents & ~(1n << BigInt(row.routingAgentIndex)),
      ),
    });

  await ctx.db.patch("assignments", row._id, { routingAgentIndex: undefined });
}

/** Whether another turn of this agent still owns the run's routing decision,
 * and the run's current model for the agent. Null for cancelled work. */
export async function routingState(
  ctx: QueryCtx,
  args: { assignmentId: Id<"assignments">; agentIndex: number },
) {
  assertAgentIndex(args.agentIndex);

  const row = await ctx.db.get("assignments", args.assignmentId);
  const run = row?.runId ? await ctx.db.get("runs", row.runId) : null;
  if (!row || !run || row.cancelled || run.cancelled) return null;

  return {
    pending: (run.routingAgents & (1n << BigInt(args.agentIndex))) !== 0n,
    modelId: run.models?.[row.agent],
  };
}

/** The routing owner finished its beforeTurn decision: release the bit if
 * this turn still owns it. */
export async function completeRoutingFor(
  ctx: MutationCtx,
  args: { assignmentId: Id<"assignments">; executionId: string; agentIndex: number },
) {
  assertAgentIndex(args.agentIndex);

  const row = await ctx.db.get("assignments", args.assignmentId);
  if (!row || row.cancelled || row.turnToken !== args.executionId || !row.runId) return null;

  if (row.routingAgentIndex === args.agentIndex) await settleRouting(ctx, row);
  return null;
}

/** Whether the run's routing decision for this agent is still pending. */
export const routing = query({
  args: { assignmentId: v.id("assignments"), agentIndex: v.number() },
  handler: (ctx, args) => routingState(ctx, args),
});

/** The routing owner finished its decision: release routing ownership. */
export const completeRouting = mutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string(), agentIndex: v.number() },
  returns: v.null(),
  handler: (ctx, args) => completeRoutingFor(ctx, args),
});
