import type { RuntimeContext } from "../registration/context.js";
import type { Generation, Turn } from "./context.js";
/**
 * Settle this turn's routing attempt for its agent. Idempotent in the
 * component; called when the run-start slice is done deciding (or failed).
 */
export declare function completeRouting(rt: RuntimeContext, turn: Turn): Promise<void>;
/**
 * Select the model for this generation: the claimed model, overridden by a
 * `beforeTurn` choice, overridden by the agent's routed decision. Throws
 * `HOOK_BLOCKED` (after marking the generation) when `beforeTurn` blocks.
 */
export declare function selectTurnModel(rt: RuntimeContext, gen: Generation): Promise<string | undefined>;
