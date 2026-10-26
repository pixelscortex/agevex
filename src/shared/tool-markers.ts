// Reserved factory metadata crosses the host/native save boundary by registration name.
import type { Schema, Tool, ToolSet } from "ai";
import type { MessageDoc } from "@convex-dev/agent";
import { assertJson, assertFormSchema, type JsonSchema } from "./decisions.js";

export type AskUserMetadata = {
  inputSchema: Schema;
  answerSchema?: JsonSchema | ((input: unknown) => JsonSchema);
};
/** Only this serializable, per-call result crosses into the component. */
export type PreparedAskUser = {
  calls: { toolCallId: string; input?: unknown; answerSchema?: JsonSchema; error?: string }[];
};
export type AskUserSave = { messages: { message: MessageDoc["message"] }[] };

/** A tool's map key is app-owned; only the factory marker grants ask-user semantics. */
export function askUserMarker(tool: Tool | undefined): AskUserMetadata | undefined {
  return (tool as (Tool & { agevexAskUser?: AskUserMetadata }) | undefined)?.agevexAskUser;
}

/** Schemas travel out of band, never in model-visible tool-call input. */
export async function askUserTools(tools: ToolSet, save: AskUserSave) {
  const prepared: Record<string, PreparedAskUser> = Object.fromEntries(
    Object.entries(tools).flatMap(([name, tool]) =>
      askUserMarker(tool) ? [[name, { calls: [] }]] : [],
    ),
  );

  for (const { message } of save.messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;

    for (const call of message.content) {
      if (
        call.type !== "tool-call" ||
        call.providerExecuted ||
        !Object.prototype.hasOwnProperty.call(prepared, call.toolName)
      )
        continue;

      prepared[call.toolName].calls.push({
        toolCallId: call.toolCallId,
        ...(await prepareAsk(tools[call.toolName], call.input)),
      });
    }
  }

  return prepared;
}

/** Validate raw native call bytes on the host, where Zod and host callbacks run.
 * Recheck transformed/defaulted output too: only bounded JSON may be persisted.
 * A bad model call or derived form is a normal tool denial, never a lost turn.
 */
async function prepareAsk(tool: Tool, input: unknown) {
  let validated: unknown;

  try {
    assertJson(input);
    const checked = await askUserMarker(tool)?.inputSchema.validate?.(input);

    if (!checked?.success) return { error: "INVALID_QUESTION" };

    validated = checked.value;
    assertJson(validated);
  } catch {
    return { error: "INVALID_QUESTION" };
  }

  try {
    const configured = askUserMarker(tool)?.answerSchema;

    const answerSchema =
      typeof configured === "function"
        ? configured(JSON.parse(JSON.stringify(validated)))
        : configured;

    if (typeof configured === "function" || answerSchema !== undefined)
      assertFormSchema(answerSchema!);

    return { input: validated, ...(answerSchema !== undefined ? { answerSchema } : {}) };
  } catch {
    return { error: "INVALID_FORM_SCHEMA" };
  }
}
