import type { RuntimeContext } from "../registration/context.js";
import { type Turn, type TurnOutcome } from "./context.js";
/**
 * Run one admitted turn's generation.
 *
 * Returns the outcome finalization should record, or `null` when the
 * generation already handed the turn on itself (continued it, finished a
 * child's question pause, or found it fenced out) and nothing is left to do.
 */
export declare function generateTurn(rt: RuntimeContext, turn: Turn): Promise<TurnOutcome | null>;
