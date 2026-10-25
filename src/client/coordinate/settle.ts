// The coordinator's `settle` op: record a child run's verified outcome.
//
// Called once per child turn by the turn runner (`turn/finish.ts`) with the child
// turn token that owns the run. `subagents.settlementContext` validates that
// capability and returns the facts settlement may assume; the reported result is
// verified against the native child transcript before `subagents.settle` writes
// any terminal state. Delivery is a separate transaction (`delivery.ts`).

import type { CoordinatorCtx, RuntimeContext } from "../registration/context.js";
import type { CoordinateArgs, RunErrorCode } from "../types.js";
import { verifyChildMessage } from "./verify.js";

type SettleArgs = Extract<CoordinateArgs, { op: "settle" }>;

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
export async function settleRun(rt: RuntimeContext, ctx: CoordinatorCtx, args: SettleArgs) {
  const settlement = await ctx.runQuery(rt.component.subagents.settlementContext, {
    assignmentId: args.assignmentId,
    turnToken: args.turnToken,
    runId: args.runId,
  });
  if (!settlement) throw new Error("FORBIDDEN");

  let errorCode: RunErrorCode = args.errorCode;
  let childResultMessageId: string | null = null;
  if (!errorCode) {
    const reported =
      args.resultMessageId === settlement.childResultMessageId ? args.resultMessageId : undefined;
    const verified = reported
      ? await verifyChildMessage(rt, ctx, {
          threadId: settlement.childThreadId,
          agentName: settlement.agent,
          messageId: reported,
          subject: settlement.subject,
        })
      : null;
    if (verified && reported) childResultMessageId = reported;
    else errorCode = "RESULT_UNVERIFIED";
  }

  await ctx.runMutation(rt.component.subagents.settle, {
    assignmentId: args.assignmentId,
    turnToken: args.turnToken,
    runId: args.runId,
    childResultMessageId,
    errorCode,
  });
  if (settlement.blocked) return { status: "deferred" as const, runId: args.runId };
  return null;
}
