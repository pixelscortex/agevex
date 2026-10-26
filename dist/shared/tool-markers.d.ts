import type { Tool, ToolSet } from "ai";
import type { JsonSchema } from "./decisions.js";
export type AskUserMetadata = {
    answerSchema?: JsonSchema;
};
/** A tool's map key is app-owned; only the factory marker grants ask-user semantics. */
export declare function askUserMarker(tool: Tool | undefined): AskUserMetadata | undefined;
/** Schemas travel out of band, never in model-visible tool-call input. */
export declare function askUserTools(tools: ToolSet): Record<string, AskUserMetadata>;
