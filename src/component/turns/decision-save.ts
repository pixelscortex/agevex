// Trusted metadata and role enforcement at the native-save transaction boundary.
import type { MessageDoc } from "@convex-dev/agent";
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import {
  DECISION_LIMITS,
  decisionBytes,
  assertFormSchema,
  type JsonSchema,
} from "../../shared/decisions.js";
import { countPauseRequests } from "./pause.js";

type NativeSave = { messages: { message: MessageDoc["message"] }[] };
type SavedMessage = NativeSave["messages"][number];

/** Recheck persisted role before any ask_user deferral, including direct saves.
 * Factory schema is trusted host metadata, never a model-supplied form program.
 * The extra run read is fixed at <=16 KiB per native save, independent of calls.
 */
export async function prepareDecisions(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  args: NativeSave,
  schema?: JsonSchema,
) {
  if (schema) assertFormSchema(schema);

  const run = row.runId ? await ctx.db.get("runs", row.runId) : null;
  const allowed = run?.settings[row.agent]?.askUser ?? !row.rootAssignmentId;

  for (const saved of args.messages) {
    if (saved.message?.role !== "assistant" || !Array.isArray(saved.message.content)) continue;

    for (const part of saved.message.content) {
      if (part.type !== "tool-call" || part.toolName !== "ask_user" || part.providerExecuted)
        continue;

      if (!allowed) {
        denyAsk(args, saved, part.toolCallId, "ROOT_ONLY");
        continue;
      }

      const input = part.input as Record<string, unknown>;

      if (
        !input ||
        typeof input.question !== "string" ||
        !input.question.trim() ||
        input.question.length > DECISION_LIMITS.questionChars ||
        Object.keys(input).some((key) => key !== "question")
      ) {
        denyAsk(args, saved, part.toolCallId, "INVALID_QUESTION");
        continue;
      }

      part.input = { question: input.question, ...(schema ? { agevexAnswerSchema: schema } : {}) };
    }
  }
}

/** Normal tool result, with no approval request left to expose to a human.
 * Preserve AI SDK's own validation result when it already recorded one.
 */
function denyAsk(args: NativeSave, saved: SavedMessage, toolCallId: string, code: string) {
  if (saved.message?.role === "assistant" && Array.isArray(saved.message.content))
    saved.message.content = saved.message.content.filter(
      (part) => part.type !== "tool-approval-request" || part.toolCallId !== toolCallId,
    );

  const resulted = args.messages.some(
    (doc) =>
      doc.message?.role === "tool" &&
      doc.message.content.some(
        (part) => part.type === "tool-result" && part.toolCallId === toolCallId,
      ),
  );

  if (!resulted)
    args.messages.push({
      message: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "ask_user",
            output: { type: "json", value: { status: "denied", code } },
          },
        ],
      },
    });
}

/** A pending source must fit in full; native storage repeats raw input metadata.
 * The post-save check rolls back its native write and coordination refs together.
 */
export function boundDecisionSources(messages: MessageDoc[], deferred: Set<string>) {
  for (const doc of messages)
    if (countPauseRequests([doc], deferred) && decisionBytes(doc) > DECISION_LIMITS.sourceBytes)
      throw new Error("PENDING_SOURCE_TOO_LARGE");
}
