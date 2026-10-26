// Trusted metadata and role enforcement at the native-save transaction boundary.
import type { MessageDoc } from "@convex-dev/agent";
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import {
  DECISION_LIMITS,
  decisionBytes,
  assertFormSchema,
  assertJson,
} from "../../shared/decisions.js";
import type { PreparedAskUser } from "../../shared/tool-markers.js";
import { oversizedAskItem } from "../../shared/ask-values.js";

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
  tools: Record<string, PreparedAskUser> = {},
) {
  const run = row.runId ? await ctx.db.get("runs", row.runId) : null;

  const allowed =
    run?.settings?.find((entry) => entry.agent === row.agent)?.settings.askUser ??
    !row.rootAssignmentId;

  for (const saved of args.messages) {
    if (saved.message?.role !== "assistant" || !Array.isArray(saved.message.content)) continue;

    for (const part of saved.message.content) {
      if (
        part.type !== "tool-call" ||
        !Object.prototype.hasOwnProperty.call(tools, part.toolName) ||
        part.providerExecuted
      )
        continue;

      if (!allowed) {
        denyAsk(args, saved, part.toolCallId, part.toolName, "ROOT_ONLY");
        continue;
      }

      const checked = tools[part.toolName].calls.find(
        (call) => call.toolCallId === part.toolCallId,
      );

      const error =
        (part.toolCallId.length > DECISION_LIMITS.identifierChars ||
        part.toolName.length > DECISION_LIMITS.identifierChars
          ? "ASK_TOO_LARGE"
          : undefined) ??
        checked?.error ??
        checkPreparedAsk(checked) ??
        (oversizedAskItem({
          id: part.toolCallId,
          toolCallId: part.toolCallId,
          tool: part.toolName,
          input: checked!.input,
          providerExecuted: false,
          ...(checked?.answerSchema !== undefined ? { schema: checked.answerSchema } : {}),
          threadId: row.threadId,
          agent: row.agent,
          kind: "ask",
        })
          ? "ASK_TOO_LARGE"
          : undefined);

      if (error) denyAsk(args, saved, part.toolCallId, part.toolName, error);
    }
  }
}

/** The component cannot execute host schemas/callbacks. Fail closed when the
 * host omitted validation, and independently enforce the storage dialect/bounds.
 */
function checkPreparedAsk(call?: PreparedAskUser["calls"][number]) {
  try {
    assertJson(call?.input);
  } catch {
    return "INVALID_QUESTION";
  }

  try {
    if (call?.answerSchema !== undefined) assertFormSchema(call.answerSchema);
  } catch {
    return "INVALID_FORM_SCHEMA";
  }

  return undefined;
}

/** Normal tool result, with no approval request left to expose to a human.
 * Preserve AI SDK's own validation result when it already recorded one.
 */
function denyAsk(
  args: NativeSave,
  saved: SavedMessage,
  toolCallId: string,
  toolName: string,
  code: string,
) {
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
            toolName,
            output: { type: "json", value: { status: "denied", code } },
          },
        ],
      },
    });
}

/** Only pending input is bounded. Reasoning/text stays in native Agent storage.
 * The caller commits APPROVAL_LIMIT before native save rather than rolling back
 * a paid model step with an untyped generation failure.
 *
 * Every unresulted deferred call must also be answerable: the pending read marks
 * an item truncated (unanswerable) when its identifiers or full projection exceed
 * the item bound, so refuse here what could never be answered once saved. Factory
 * asks are checked on their normalized form in `prepareDecisions` instead.
 */
export function oversizedDecisionInput(
  messages: NativeSave["messages"],
  deferred: Set<string>,
  owner: { threadId: string; agent: string },
  asks: Record<string, PreparedAskUser> = {},
) {
  const resulted = new Set(
    messages.flatMap(({ message }) =>
      message?.role === "tool"
        ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
        : [],
    ),
  );

  return messages.some(({ message }) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;

    const approvals = new Set(
      message.content.flatMap((part) =>
        part.type === "tool-approval-request" ? [part.toolCallId] : [],
      ),
    );

    return message.content.some((part) => {
      if (part.type !== "tool-call") return false;

      const pending =
        deferred.has(part.toolName) && !part.providerExecuted && !resulted.has(part.toolCallId);

      return (
        ((!deferred.has(part.toolName) ||
          part.providerExecuted ||
          !resulted.has(part.toolCallId)) &&
          (approvals.has(part.toolCallId) || deferred.has(part.toolName)) &&
          decisionBytes(part.input) > DECISION_LIMITS.valueBytes) ||
        (pending && unanswerablePending(part, owner, asks))
      );
    });
  });
}

/** A pending read would project this deferred call as a truncated stub. */
function unanswerablePending(
  part: { toolCallId: string; toolName: string; input?: unknown },
  owner: { threadId: string; agent: string },
  asks: Record<string, PreparedAskUser>,
) {
  if (
    part.toolCallId.length > DECISION_LIMITS.identifierChars ||
    part.toolName.length > DECISION_LIMITS.identifierChars
  )
    return true;

  if (Object.prototype.hasOwnProperty.call(asks, part.toolName)) return false;

  return oversizedAskItem({
    id: part.toolCallId,
    toolCallId: part.toolCallId,
    tool: part.toolName,
    input: part.input ?? null,
    providerExecuted: false,
    ...owner,
    kind: "ask",
  });
}
