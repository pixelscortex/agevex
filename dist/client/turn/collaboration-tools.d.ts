import { type ToolSet } from "ai";
import { type RuntimeContext } from "../registration/context.js";
import type { Generation } from "./context.js";
/** Install the collaboration tools this turn is eligible for into `tools`. */
export declare function installCollaborationTools(rt: RuntimeContext, gen: Generation, tools: ToolSet, eligible: boolean): void;
