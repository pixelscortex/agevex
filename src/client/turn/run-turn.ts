// The `runTurn` internal action: one managed turn, end to end.
//
// The component's Workflow loop schedules `runTurn` (the host exports it as
// `refs.runTurn`) once per turn slice. The handler is a short composition of the
// turn phases: load and claim (`claim.ts`), execution admission
// (`admission.ts`), one generation (`generation.ts`), finalization
// (`finish.ts`), and a bounded telemetry flush on every exit after a successful
// claim. Each phase is a separate module; this file only fixes their order.

import { internalActionGeneric, type RegisteredAction } from "convex/server";
import { v } from "convex/values";
import { observe, type RunnerCtx, type RuntimeContext } from "../registration/context.js";
import type { TurnArgs } from "../types.js";
import { admitExecution } from "./admission.js";
import { claimTurn, loadExecution } from "./claim.js";
import type { Turn, TurnOutcome } from "./context.js";
import { finishTurn } from "./finish.js";
import { generateTurn } from "./generation.js";
import { completeRouting } from "./routing.js";
import { flushTelemetry } from "./slots.js";

/** Build the registered `runTurn` action for one registration. */
export function buildRunTurn(rt: RuntimeContext): RegisteredAction<"internal", TurnArgs, null> {
  return internalActionGeneric({
    args: { assignmentId: v.string(), turnToken: v.string(), sliceId: v.optional(v.string()) },
    returns: v.null(),
    handler: (ctx, args) => runTurn(rt, ctx, args),
  });
}

/**
 * Run one scheduled turn slice. Returns `null` in every case; the outcome is
 * persisted queue state. A stale or refused claim does nothing at all.
 */
async function runTurn(rt: RuntimeContext, ctx: RunnerCtx, args: TurnArgs): Promise<null> {
  const loaded = await loadExecution(rt, ctx, args);

  if (!loaded) return null;

  const turn = await claimTurn(rt, ctx, args, loaded.queued, loaded.managed);

  if (!turn) return null;

  try {
    return await executeTurn(rt, turn);
  } finally {
    await flushTelemetry(rt.config, turn.facts, turn.turnKey);
  }
}

/**
 * Admit, generate and finalize one claimed turn.
 *
 * A refused admission skips generation entirely and finalizes with its error
 * code; a generation that handed the turn on itself (`null`) is not finalized.
 */
async function executeTurn(rt: RuntimeContext, turn: Turn): Promise<null> {
  const { claimed, managed } = turn;

  await observe(rt, turn.rawCtx, {
    type: "turn.claimed",
    assignmentId: claimed.assignmentId,
    threadId: claimed.threadId,
    agent: claimed.agent,
    turnOrigin: claimed.turnOrigin,
  });

  const refused = await admitExecution(rt, turn);

  const outcome: TurnOutcome | null = refused
    ? { errorCode: refused, childError: refused }
    : await generateTurn(rt, turn);

  if (!outcome) return null;

  // Authorization runs before the generation try/finally. A denial
  // must settle the same routing attempt as generation/hook failures;
  // queue's terminal fences also cover actions that never return here.
  if (
    outcome.errorCode === "AUTHORIZATION_DENIED" &&
    claimed.isRunStart &&
    managed.hooks?.beforeTurn
  )
    await completeRouting(rt, turn);

  return finishTurn(rt, turn, outcome);
}
