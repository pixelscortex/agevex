// Child-result verification against the native child transcript.
//
// A delegated child's result is only ever a message id the component recorded;
// before the runtime settles, delivers or answers with it, `verifyChildMessage`
// proves that exact id is a successful, non-empty assistant message by the
// expected child agent on the subject's own child thread. Called by settlement
// (`settle.ts`), delivery (`delivery.ts`) and `ask` (`interaction.ts`). Reads one
// native thread and one native message by id; never lists the transcript.

import { getThreadMetadata } from "@convex-dev/agent";
import type { CoordinatorCtx, RuntimeContext } from "../registration/context.js";

/** The native facts one child-result verification is allowed to assume. */
export type ChildResultTarget = {
  threadId: string;
  agentName: string;
  messageId: string;
  subject: string;
};

/**
 * Authenticate one child's final message against the native child transcript.
 *
 * Requires the thread to exist and still belong to the stored subject, and the
 * exact stored message id to be an `assistant` `success` message attributed to
 * the expected child agent and carry non-empty text. A caller-selected message id
 * therefore cannot settle or be delivered as a result, a tool-only or empty
 * completion is rejected, and a foreign thread is refused even when it holds a
 * message with the same id.
 *
 * The `assistant` role is what makes this a result and not merely a saved
 * message: native `saveMessage` lets a caller store a `user` message that names
 * an agent, so a user-role message on the correct child thread would otherwise
 * pass every other check and settle a run with no final assistant output. Native
 * user prompts are still stored and read normally; only result verification
 * requires the assistant role.
 *
 * Returns the verified text, or `null` when the message cannot be trusted.
 */
export async function verifyChildMessage(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  target: ChildResultTarget,
): Promise<string | null> {
  const child = rt.graph.children.get(target.agentName);

  if (!child) return null;

  const thread = await getThreadMetadata(ctx, child.component, { threadId: target.threadId });

  if (!thread || thread.userId !== target.subject) return null;

  // An untrusted reported id can fail the native id validator. Treat that
  // just like a missing document: no verified result, and no transcript scan.
  const found = await ctx
    .runQuery(child.component.messages.getMessagesByIds, {
      messageIds: [target.messageId],
    })
    .then(
      ([message]) => message,
      () => null,
    );

  if (
    !found ||
    found.threadId !== target.threadId ||
    found.message?.role !== "assistant" ||
    found.status !== "success" ||
    found.agentName !== target.agentName
  )
    return null;

  // `text` is the native extraction of this saved message's text parts.
  const text = found.text;

  return text && text.trim() ? text : null;
}
