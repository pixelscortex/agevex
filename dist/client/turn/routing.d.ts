import type { RuntimeContext } from "../registration/context.js";
import type { Generation } from "./context.js";
/** Select this generation's allowlisted model and honor a beforeTurn block. */
export declare function selectTurnModel(rt: RuntimeContext, gen: Generation): Promise<string | undefined>;
