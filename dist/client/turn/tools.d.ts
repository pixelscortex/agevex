import type { Tool, ToolSet } from "ai";
import type { RuntimeContext } from "../registration/context.js";
import type { Generation } from "./context.js";
/** Build the complete tool set for one generation. */
export declare function buildTurnTools(rt: RuntimeContext, gen: Generation): Promise<ToolSet>;
/** Native Agent preserves our execute receiver (vercel/client/createTool.ts:378).
 * Mark all local calls, including collaboration, without exposing their inputs.
 * A stream stays active through consumption, cancellation or its final yield.
 */
export declare function withToolProgress(rt: RuntimeContext, gen: Generation, name: string, tool: Tool): Tool;
