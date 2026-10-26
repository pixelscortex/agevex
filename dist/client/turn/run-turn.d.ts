import { type RegisteredAction } from "convex/server";
import { type RuntimeContext } from "../registration/context.js";
import type { TurnArgs } from "../types.js";
/** Build the registered `runTurn` action for one registration. */
export declare function buildRunTurn(rt: RuntimeContext): RegisteredAction<"internal", TurnArgs, null>;
