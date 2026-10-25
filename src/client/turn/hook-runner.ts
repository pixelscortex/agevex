// Running host hooks (`beforeTurn`, `beforeTool`, `afterTool`, `beforeDelegate`,
// `afterTurn`) inside one turn.
//
// `hookRunner` returns the single function every hook call goes through. It
// validates the hook's result against the turn's bounds, posts a returned `note`
// under the turn's fence (`hooks.notes.addNote`, or `hooks.notes.beforeTurnNote` for
// `beforeTurn`, which must land before the prompt), and turns any hook failure
// into `HOOK_FAILED`: it marks the generation, aborts the model call and throws.
// Built by `turn/generation.ts`; used by routing, tools and completion.

import { createFunctionHandle } from "convex/server";
import { LIMITS } from "../../component/limits.js";
import type { RuntimeContext } from "../registration/context.js";
import type { HookResult } from "../types.js";
import type { Claimed, GenerationState, HookRunner, Turn } from "./context.js";
import type { TurnFence } from "./fence.js";

/**
 * Build the hook runner for one generation.
 *
 * `allowModel` is true only for `beforeTurn`: it is the one hook that may pick a
 * model (at the start of a run's first turn) and whose note is inserted before
 * the prompt. The hook's own error is never persisted.
 */
export function hookRunner(
  rt: RuntimeContext,
  turn: Turn,
  fence: TurnFence,
  state: GenerationState,
): HookRunner {
  return async (invoke, allowModel = false) => {
    try {
      const result = await invoke?.();

      assertHookResult(rt, turn.claimed, result, allowModel);

      if (result?.note) await postHookNote(rt, turn, fence, result.note, allowModel);

      return result;
    } catch {
      // The hook's own error is never persisted: nothing reads it and
      // it may carry private details. The turn reports HOOK_FAILED.
      state.hookFailed = true;
      fence.controller.abort();
      throw new Error("HOOK_FAILED");
    }
  };
}

/**
 * Every string a hook returns must be non-empty and within the bound of where it
 * ends up (a note, a block reason, a continuation prompt, a model id), and a
 * `model` is accepted only from `beforeTurn` at the start of a run.
 */
function assertHookResult(
  rt: RuntimeContext,
  claimed: Claimed,
  result: HookResult,
  allowModel: boolean,
) {
  for (const [key, max] of [
    ["note", LIMITS.noteLength],
    ["block", rt.limits.taskLength],
    ["continue", LIMITS.messageLength],
    ["model", LIMITS.modelIdLength],
  ] as const) {
    const value = result?.[key];

    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > max))
      throw new Error(`INVALID_HOOK_${key.toUpperCase()}`);
  }

  if (result?.model !== undefined && (!allowModel || !claimed.isTurnStart || !claimed.isRunStart))
    throw new Error("MODEL_ONLY_AT_RUN_START");
}

/** Post a hook's note under the turn's fence, attributed to the agent. */
async function postHookNote(
  rt: RuntimeContext,
  turn: Turn,
  fence: TurnFence,
  text: string,
  beforeTurn: boolean,
) {
  const { claimed, managed } = turn;

  await fence.ctx.runMutation(
    beforeTurn ? rt.component.hooks.notes.beforeTurnNote : rt.component.hooks.notes.addNote,
    {
      assignmentId: claimed.assignmentId,
      text,
      from: managed.name,
      ...(beforeTurn
        ? {
            addMessages: await createFunctionHandle(managed.component.messages.addMessages),
            getMessages: await createFunctionHandle(managed.component.messages.getMessagesByIds),
          }
        : {}),
    },
  );
}
