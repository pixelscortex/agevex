/** Conservative native context selection. Exact refs preserve the complete
 * recent suffix; missing refs, changed documents or non-text coverage fall back
 * to native selection. Original messages are never rewritten or deleted. */
import { docsToModelMessages, type ContextHandler } from "@convex-dev/agent";
import { getConvexSize } from "convex/values";
import { TEXT_LIMITS } from "../../component/text/values.js";
import { after } from "../../component/text/window.js";
import type { RuntimeContext } from "../registration/context.js";
import type { Turn } from "../turn/context.js";

/** Only safe subsequent root turns apply compaction. A gap or unsafe summary
 * leaves the host's normal native context handler and selection untouched. */
export async function compactContext(
  rt: RuntimeContext,
  turn: Turn,
): Promise<ContextHandler | undefined> {
  if (!rt.config.summary || !rt.config.summary.compact || turn.child || !turn.claimed.isTurnStart)
    return;

  try {
    const state = await turn.rawCtx.runQuery(rt.component.text.state.view, {
      assignmentId: turn.args.assignmentId,
    });

    const summary = state.summary;

    if (!summary?.complete || summary.epoch !== state.epoch || state.cancelled) return;

    const anchor = state.refs.find((ref) => ref.id === turn.claimed.promptMessageId);

    if (!anchor || !after(anchor, summary.through)) return;

    const tail = state.refs
      .filter((ref) => ref.sequence > summary.through.sequence)
      .sort((a, b) => a.sequence - b.sequence);

    if (!tail.length || tail.some((ref, i) => ref.sequence !== summary.through.sequence + i + 1))
      return;

    const refs = tail
      .filter((ref) => after(ref, summary.through) && after(anchor, ref))
      .sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);

    if (refs.reduce((sum, ref) => sum + ref.bytes, 0) > TEXT_LIMITS.readBytes) return;

    const docs = await turn.rawCtx.runQuery(turn.managed.component.messages.getMessagesByIds, {
      messageIds: refs.map((ref) => ref.id),
    });

    if (docs.some((doc, i) => !doc || getConvexSize(doc) > refs[i].bytes)) return;

    // Host approval responses are owned by the native pause protocol. Until
    // every such exchange is captured, leave any non-text suffix native too.
    if (
      docs.some(
        (doc) =>
          doc?.message &&
          typeof doc.message.content !== "string" &&
          doc.message.content.some((part) => part.type !== "text"),
      )
    )
      return;

    const recent = docsToModelMessages(docs.filter((doc) => doc !== null));

    if (new TextEncoder().encode(JSON.stringify(recent)).length > TEXT_LIMITS.inputBytes) return;

    // Native Agent search.ts:693-705 keeps prompt and existing same-order
    // responses separate. Preserve both verbatim, including attachments/tools.
    return async (_ctx, input) => [
      { role: "system", content: `Conversation summary:\n${summary.text}` },
      ...recent,
      ...input.inputMessages,
      ...input.inputPrompt,
      ...input.existingResponses,
    ];
  } catch {
    /* Summary availability must never determine conversation success. */
  }
}
