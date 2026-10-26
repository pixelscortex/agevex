import { type RuntimeContext } from "../registration/context.js";
import { type Turn, type TurnOutcome } from "./context.js";
/**
 * Record a turn's outcome, unless it no longer owns its execution (cancelled or
 * superseded), in which case nothing is written.
 */
export declare function finishTurn(rt: RuntimeContext, turn: Turn, outcome: TurnOutcome): Promise<null>;
