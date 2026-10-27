/**
 * Child-to-parent progress under a running turn capability. The component
 * derives the immediate parent, caps admission and replays exact receipt ids.
 * Native save, queue publication and receipt all share this host transaction.
 */
import { parentNoteFits } from "../../component/subagents/parent_notes.js";
import { fingerprint, opaqueKey } from "../keys.js";
import { saveMessage } from "@convex-dev/agent";
/** Report progress using trusted persisted identities and the host delivery policy. */
export async function messageParent(rt, ctx, args) {
    if (!args.text.trim())
        return { status: "denied", code: "MESSAGE_EMPTY" };
    if (!parentNoteFits(args.text))
        return { status: "denied", code: "MESSAGE_TOO_LARGE" };
    const input = {
        assignmentId: args.assignmentId,
        turnToken: args.turnToken,
        text: args.text,
        key: await opaqueKey("parent-note", args.turnToken, args.toolCallId),
        fingerprint: await fingerprint(args.text),
    };
    const target = await ctx.runQuery(rt.component.subagents.parent_notes.parentNoteContext, input);
    if (target.kind === "denied")
        return { status: "denied", code: target.code };
    if (target.kind === "replay")
        return { status: "accepted", messageId: target.messageId };
    const parent = rt.graph.byName.get(target.parentAgent);
    if (!parent || !rt.graph.children.has(target.agent))
        return { status: "denied", code: "FORBIDDEN" };
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
        if (grant.subject !== target.subject)
            throw new Error("FORBIDDEN");
    }
    catch {
        return { status: "denied", code: "FORBIDDEN" };
    }
    const { messageId } = await saveMessage(ctx, parent.component, {
        threadId: target.parentThreadId,
        prompt: `${target.agent} reports progress (run ${target.runId}):\n\n${args.text}`,
        agentName: target.agent,
        userId: target.subject,
    });
    return ctx.runMutation(rt.component.subagents.parent_notes.messageParent, {
        ...input,
        messageId,
    });
}
