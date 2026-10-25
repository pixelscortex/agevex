// Claiming one queued turn.
//
// The Workflow loop schedules `runTurn` with an assignment id and turn token;
// before any host code runs, `loadExecution` checks the execution row still
// belongs to that token and is not waiting on an approval, and `claimTurn` calls
// `queue.claim` (which delivers pending notes into the native thread with the
// handles passed here) and builds the `Turn` every later phase receives.

import { createFunctionHandle } from "convex/server";
import { opaqueKey } from "../keys.js";
import type { RunnerCtx, RuntimeContext } from "../registration/context.js";
import type { ManagedAgent, TurnArgs } from "../types.js";
import type { Turn } from "./context.js";

/**
 * Load the execution this action was scheduled for, or `null` when the action
 * is stale (cancelled, superseded token) or blocked on a recorded approval.
 * Throws `UNKNOWN_AGENT` when the stored agent is no longer registered.
 */
export async function loadExecution(rt: RuntimeContext, ctx: RunnerCtx, args: TurnArgs) {
  const queued = await ctx.runQuery(rt.component.queue.execution, {
    assignmentId: args.assignmentId,
  });
  if (!queued || queued.cancelled || queued.turnToken !== args.turnToken) return null;

  const managed = rt.graph.byName.get(queued.agent);
  if (!managed) throw new Error("UNKNOWN_AGENT");

  // Agent 0.7.7 auto-denies unresolved approvals at generation start.
  // Only our recorded request can block a managed turn. Native history
  // is never searched to discover requests.
  if (queued.approvalBlocked) return null;
  return { queued, managed };
}

/**
 * Claim the turn and build its `Turn`, or `null` when the claim is refused
 * (another action owns it, or it was cancelled in between).
 *
 * `routeModel` asks the claim to open a per-agent routing decision when the
 * agent has a `beforeTurn` hook; `notes` are the native handles the claim uses
 * to move pending notes into the transcript at this safe point.
 */
export async function claimTurn(
  rt: RuntimeContext,
  ctx: RunnerCtx,
  args: TurnArgs,
  queued: Turn["queued"],
  managed: ManagedAgent,
): Promise<Turn | null> {
  const claimed = await ctx.runMutation(rt.component.queue.claim, {
    ...args,
    agentIndex: rt.agentIndexes.get(queued.agent),
    routeModel: !!managed.hooks?.beforeTurn,
    notes: {
      getMessages: await createFunctionHandle(managed.component.messages.getMessagesByIds),
      addMessages: await createFunctionHandle(managed.component.messages.addMessages),
      updateMessage: await createFunctionHandle(managed.component.messages.updateMessage),
    },
  });
  if (!claimed) return null;

  const child = claimed.subagent;
  const turnKey = await opaqueKey("turn", args.sliceId ?? args.turnToken);
  const facts = {
    subject: claimed.subject,
    rootThreadId: child?.rootThreadId ?? claimed.threadId,
    threadId: claimed.threadId,
    runId: claimed.runId,
    agent: claimed.agent,
  };
  return { ctx, args, queued, managed, claimed, child, turnKey, facts };
}
