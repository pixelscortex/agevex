// Model selection for one turn: the `beforeTurn` hook and per-agent routing.
//
// At a turn's start `beforeTurn` may add a note, block the turn, or (at a run's
// start) pick an allowlisted model, which is persisted with `hooks.state.hookState`.
// Siblings of the same agent in one request share that decision: the run-start
// slice completes the routing attempt (`hooks.routing.completeRouting`) and every slice
// waits on `hooks.routing.routing` until it is decided. `completeRouting` is also called
// on every exit path by `turn/generation.ts` and `turn/run-turn.ts`, so a failed
// or refused turn never leaves siblings waiting.

import { LIMITS } from "../../component/limits.js";
import type { RuntimeContext } from "../registration/context.js";
import type { Generation, Turn } from "./context.js";

/**
 * Settle this turn's routing attempt for its agent. Idempotent in the
 * component; called when the run-start slice is done deciding (or failed).
 */
export async function completeRouting(rt: RuntimeContext, turn: Turn) {
  await turn.rawCtx.runMutation(rt.component.hooks.routing.completeRouting, {
    assignmentId: turn.claimed.assignmentId,
    executionId: turn.args.turnToken,
    agentIndex: rt.agentIndexes.get(turn.claimed.agent)!,
  });
}

/**
 * Select the model for this generation: the claimed model, overridden by a
 * `beforeTurn` choice, overridden by the agent's routed decision. Throws
 * `HOOK_BLOCKED` (after marking the generation) when `beforeTurn` blocks.
 */
export async function selectTurnModel(rt: RuntimeContext, gen: Generation) {
  const { claimed, managed } = gen.turn;
  let selectedModel = claimed.modelId;

  if (claimed.isTurnStart && managed.hooks?.beforeTurn)
    selectedModel = (await runBeforeTurn(rt, gen)) ?? selectedModel;

  if (managed.hooks?.beforeTurn) selectedModel = (await awaitRoutedModel(rt, gen)) ?? selectedModel;

  return selectedModel;
}

/**
 * Run `beforeTurn` on the turn's prompt (a continuation's own prompt
 * after an afterTurn continuation). Returns the model it picked
 * (validated against the allowlist and persisted), if any.
 */
async function runBeforeTurn(rt: RuntimeContext, gen: Generation) {
  const { turn, hc, hook, fence } = gen;
  const { claimed, managed } = turn;

  const docs = await turn.rawCtx.runQuery(managed.component.messages.getMessagesByIds, {
    messageIds: [claimed.promptMessageId],
  });

  const before = await hook(
    () =>
      managed.hooks!.beforeTurn!(hc, {
        prompt: docs[0]?.text ?? "",
        isRunStart: claimed.isRunStart,
      }),
    true,
  );

  let model: string | undefined;

  if (before?.model) {
    await hook(async () => {
      if (!rt.config.models || !rt.config.modelAllowlist?.includes(before.model!))
        throw new Error("MODEL_NOT_ALLOWED");

      await fence.ctx.runMutation(rt.component.hooks.state.hookState, {
        assignmentId: claimed.assignmentId,
        executionId: turn.args.turnToken,
        model: before.model,
      });
    });

    model = before.model;
  }

  if (before?.block) {
    gen.state.hookBlocked = true;
    throw new Error("HOOK_BLOCKED");
  }

  return model;
}

/**
 * Wait for this agent's routing decision and return its model.
 *
 * Siblings share one agent model for this request. Waiting here
 * spends no paid model work and creates no Workflow steps; the
 * first slice owns the decision, never a second classifier call.
 * Every poll re-checks the fence, so a cancelled turn stops waiting.
 */
async function awaitRoutedModel(rt: RuntimeContext, gen: Generation) {
  const { turn, fence } = gen;
  const { claimed } = turn;

  if (claimed.isRunStart) await completeRouting(rt, turn);

  const readRouting = () =>
    turn.rawCtx.runQuery(rt.component.hooks.routing.routing, {
      assignmentId: claimed.assignmentId,
      agentIndex: rt.agentIndexes.get(claimed.agent)!,
    });

  let routing = await readRouting();

  while (routing?.pending) {
    await new Promise((resolve) => setTimeout(resolve, LIMITS.cancelPollMs));
    await fence.assertActive();
    routing = await readRouting();
  }

  return routing?.modelId;
}
