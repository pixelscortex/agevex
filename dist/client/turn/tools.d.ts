import type { ToolSet } from "ai";
import type { RuntimeContext } from "../registration/context.js";
import type { Generation } from "./context.js";
/** Build the complete tool set for one generation. */
export declare function buildTurnTools(rt: RuntimeContext, gen: Generation): Promise<ToolSet>;
