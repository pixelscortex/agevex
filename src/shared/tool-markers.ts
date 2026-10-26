// Reserved factory metadata crosses the host/native save boundary by registration name.
import type { Tool, ToolSet } from "ai";
import type { JsonSchema } from "./decisions.js";

export type AskUserMetadata = { answerSchema?: JsonSchema };

/** A tool's map key is app-owned; only the factory marker grants ask-user semantics. */
export function askUserMarker(tool: Tool | undefined): AskUserMetadata | undefined {
  return (tool as (Tool & { agevexAskUser?: AskUserMetadata }) | undefined)?.agevexAskUser;
}

/** Schemas travel out of band, never in model-visible tool-call input. */
export function askUserTools(tools: ToolSet): Record<string, AskUserMetadata> {
  return Object.fromEntries(
    Object.entries(tools).flatMap(([name, tool]) => {
      const marker = askUserMarker(tool);

      return marker
        ? [[name, marker.answerSchema ? { answerSchema: marker.answerSchema } : {}]]
        : [];
    }),
  );
}
