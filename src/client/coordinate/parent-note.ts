/**
 * Child-to-parent progress under a running turn capability. The component
 * derives the immediate parent, caps admission and replays exact receipt ids.
 * Native save, queue publication and receipt all share this host transaction.
 */
import { parentNoteFits } from "../../component/subagents/parent-notes.js";
import { fingerprint, opaqueKey } from "../keys.js";
import { saveTrackedMessage } from "../native-saves.js";
import type { CoordinatorCtx, RuntimeContext } from "../registration/context.js";
import type { CoordinateArgs } from "../types.js";

/** Report progress using trusted persisted identities and the host delivery policy. */
export async function messageParent(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  args: Extract<CoordinateArgs, { op: "message_parent" }>,
) {
  if (!args.text.trim()) return { status: "denied" as const, code: "MESSAGE_EMPTY" as const };

  if (!parentNoteFits(args.text))
    return { status: "denied" as const, code: "MESSAGE_TOO_LARGE" as const };

  const input = {
    assignmentId: args.assignmentId,
    turnToken: args.turnToken,
    text: args.text,
    key: await opaqueKey("parent-note", args.turnToken, args.toolCallId),
    fingerprint: await fingerprint(args.text),
  };

  const target = await ctx.runQuery(
    rt.component.subagents["parent-notes"].parentNoteContext,
    input,
  );

  if (target.kind === "denied") return { status: "denied" as const, code: target.code };

  if (target.kind === "replay") return { status: "accepted" as const, messageId: target.messageId };

  const parent = rt.graph.byName.get(target.parentAgent);

  if (!parent || !rt.graph.children.has(target.agent))
    return { status: "denied" as const, code: "FORBIDDEN" as const };

  try {
    const grant = await rt.config.authorize(ctx, {
      operation: "deliver",
      agent: target.rootAgent,
      threadId: target.rootThreadId,
      subject: target.subject,
      rootAssignmentId: target.rootAssignmentId,
      rootAgent: target.rootAgent,
      actorAgent: target.parentAgent,
      childAgent: target.agent,
      runId: target.runId,
    });

    if (grant.subject !== target.subject) throw new Error("FORBIDDEN");
  } catch {
    return { status: "denied" as const, code: "FORBIDDEN" as const };
  }

  const { messageId } = await saveTrackedMessage(rt, ctx, parent.component, {
    threadId: target.parentThreadId,
    prompt: `${target.agent} reports progress (run ${target.runId}):\n\n${args.text}`,
    agentName: target.agent,
    userId: target.subject,
  });

  return ctx.runMutation(rt.component.subagents["parent-notes"].messageParent, {
    ...input,
    messageId,
  });
}
