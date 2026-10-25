// Finalizing a turn: record its outcome in the queue (and, for a child, its run).
//
// `finishTurn` re-checks the fence, then a root turn calls `turns.slices.finish`; a child
// turn settles its run through the coordinator (`coordinate/settle.ts`), attempts
// the one-shot delivery (`coordinate/delivery.ts`) and only then calls
// `turns.slices.finish`. Settlement, delivery and finalization are three separate
// transactions so none can roll back another's outcome. Called by
// `turn/run-turn.ts` with the outcome of admission or generation.

import { deliverTerminalRun } from "../coordinate/delivery.js";
import { coordinateRef, observe, type RuntimeContext } from "../registration/context.js";
import type { Activity } from "../types.js";
import { stillOwns, type Turn, type TurnOutcome } from "./context.js";

type ChildRun = NonNullable<Turn["child"]>;

/**
 * Record a turn's outcome, unless it no longer owns its execution (cancelled or
 * superseded), in which case nothing is written.
 */
export async function finishTurn(
  rt: RuntimeContext,
  turn: Turn,
  outcome: TurnOutcome,
): Promise<null> {
  const current = await turn.rawCtx.runQuery(rt.component.turns.slices.execution, {
    assignmentId: turn.args.assignmentId,
  });
  if (!stillOwns(current, turn)) return null;

  if (!turn.child) {
    // A root turn owns nothing but its own queue state.
    await finishQueueTurn(rt, turn, outcome.errorCode);
    await observeFinished(rt, turn, outcome.errorCode);
    return null;
  }
  return finishChildTurn(rt, turn, turn.child, outcome);
}

/**
 * Settle, deliver and finish one child turn.
 *
 * A child turn additionally owns exactly one run. Settlement,
 * delivery and finalization are three separate transactions, so none
 * can roll back another's outcome, and the child token still owns the
 * run until `turns.slices.finish` releases it.
 */
async function finishChildTurn(
  rt: RuntimeContext,
  turn: Turn,
  child: ChildRun,
  outcome: TurnOutcome,
): Promise<null> {
  try {
    if (await settleChildRun(rt, turn, child, outcome)) return null;
  } catch {
    // The outcome could not be recorded, so this failure propagates on
    // purpose. Finishing the turn here would clear the child token and
    // with it the only claim-armed watchdog that could still record this
    // run, stranding it active forever. `workflows.worker.dispatch` catches the
    // thrown action and calls `turns.failures.ambiguous`, which fails the turn
    // and escalates the run exactly once; nothing replays the
    // generation.
    throw new Error("EXECUTION_AMBIGUOUS");
  }

  // Delivery is attempted here, after the outcome is committed and
  // before the turn is finalized. The child turn owns the delivery
  // capability, so finalizing first would let a `turns.slices.finish` failure
  // skip notification permanently: the run would already be terminal,
  // `escalate` would return without scheduling anything, and the
  // watchdog ignores a recovery-required child. Ordering it first makes
  // delivery independent of the finalization outcome, and it is still
  // bounded and one-shot — `deliver` no-ops once delivery is no longer
  // `pending`, so the ambiguity path cannot replay it.
  await deliverTerminalRun(rt, turn.rawCtx, child.runId, child.deliveryToken);
  await finishQueueTurn(rt, turn, outcome.errorCode);
  await observeFinished(rt, turn, outcome.errorCode);
  return null;
}

/**
 * Settle the child's run with its outcome. Returns true when settlement was
 * deferred, in which case the turn is already finished here.
 */
async function settleChildRun(
  rt: RuntimeContext,
  turn: Turn,
  child: ChildRun,
  outcome: TurnOutcome,
): Promise<boolean> {
  const settlement = await turn.rawCtx.runMutation(coordinateRef(rt), {
    op: "settle",
    assignmentId: turn.args.assignmentId,
    turnToken: turn.args.turnToken,
    runId: child.runId,
    ...(outcome.childResultMessageId ? { resultMessageId: outcome.childResultMessageId } : {}),
    errorCode: outcome.childError,
  });
  if (settlement?.status === "deferred") {
    // This verified outcome is retained while descendants/inbox
    // fence settlement. New work replaces it on the next claim; if
    // delivery leaves no work, clearing the fence settles it as-is.
    await finishQueueTurn(rt, turn, null);
    return true;
  }

  await observe(rt, turn.rawCtx, {
    type: "delegation.settled",
    runId: child.runId,
    rootAssignmentId: child.rootAssignmentId,
    agent: child.agent,
    outcome: outcome.childError ? "failed" : "completed",
  });
  return false;
}

function finishQueueTurn(rt: RuntimeContext, turn: Turn, errorCode: Activity["errorCode"]) {
  return turn.rawCtx.runMutation(rt.component.turns.slices.finish, {
    assignmentId: turn.args.assignmentId,
    turnToken: turn.args.turnToken,
    errorCode,
  });
}

function observeFinished(rt: RuntimeContext, turn: Turn, errorCode: Activity["errorCode"]) {
  return observe(rt, turn.rawCtx, {
    type: "turn.finished",
    assignmentId: turn.claimed.assignmentId,
    threadId: turn.claimed.threadId,
    agent: turn.claimed.agent,
    outcome: errorCode ? "failure" : "success",
    errorCode,
  });
}
