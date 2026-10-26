import { type Schema, type Tool, type ToolSet } from "ai";
import type { MessageDoc } from "@convex-dev/agent";
import { type JsonSchema } from "./decisions.js";
export type AskUserMetadata = {
    inputSchema?: Schema;
    answerSchema?: JsonSchema | ((input: unknown) => JsonSchema);
};
/** Only this serializable, per-call result crosses into the component. */
export type PreparedAskUser = {
    calls: {
        toolCallId: string;
        input?: unknown;
        answerSchema?: JsonSchema;
        error?: string;
    }[];
};
export type AskUserSave = {
    messages: {
        message: MessageDoc["message"];
    }[];
};
/** A tool's map key is app-owned; only the factory marker grants ask-user semantics. */
export declare function askUserMarker(tool: Tool | undefined): AskUserMetadata | undefined;
/** Schemas travel out of band, never in model-visible tool-call input. */
export declare function askUserTools(tools: ToolSet, save: AskUserSave): Promise<Record<string, PreparedAskUser>>;
