import type { RuntimeContext } from "../registration/context.js";
import type { GenerationState, HookRunner, Turn } from "./context.js";
import type { TurnFence } from "./fence.js";
/**
 * Build the hook runner for one generation.
 *
 * `allowModel` is true only for `beforeTurn`: it is the one hook that may pick a
 * model (at the start of a run's first turn) and whose note is inserted before
 * the prompt. The hook's own error is never persisted.
 */
export declare function hookRunner(rt: RuntimeContext, turn: Turn, fence: TurnFence, state: GenerationState): HookRunner;
