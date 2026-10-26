// The coordinator's `message` and `ask` ops: conversation between a parent and a
// running child.
//
// `message` (tool `agevex_message_child`) sends a parent's follow-up into a child
// thread; `ask` (tool `agevex_ask_parent`) posts a child's question into the
// parent thread and pauses the child. Both validate the actor's running turn
// token (`subagents.messages.interactionContext`), reuse the background delegate/deliver
// host policy, save native messages, and admit them through
// `subagents.messages.messageChild` / `subagents.messages.askParent` in one transaction.
import { saveMessage } from "@convex-dev/agent";
import { saveTrackedMessage } from "../native-saves.js";
import { verifyChildMessage } from "./verify.js";
const forbidden = { status: "denied", code: "FORBIDDEN" };
/**
 * Run one `message` or `ask` interaction for the actor's running turn.
 *
 * Denials (bad length, stale token, no edge, unknown agent, policy refusal) are
 * returned as tool results before any native write.
 */
export async function interact(rt, ctx, args) {
    // Each native save reads at most its one <=1 MiB tail document.
    // message: one <=128 KiB saved text projection; ask: two such
    // saves +one <=128 KiB exact question verification. Add <=2.25 MiB
    // bounded inbox/group recovery and <128 KiB admission metadata:
    // either transaction stays <8 MiB, <600 reads and <128 writes.
    // No backlog or transcript body scan participates in admission.
    const text = (args.op === "message" ? args.text : args.question).trim();
    if (!text || text.length > rt.limits.taskLength)
        return { status: "denied", code: "TASK_LIMIT" };
    const target = await ctx.runQuery(rt.component.subagents.messages.interactionContext, {
        assignmentId: args.assignmentId,
        turnToken: args.turnToken,
        op: args.op,
        ...(args.op === "message" ? { runId: args.runId } : {}),
    });
    if (target.kind === "denied")
        return { status: "denied", code: target.code };
    if (args.op === "message" && !rt.graph.edges.get(target.actorAgent)?.size)
        return forbidden;
    const childAgent = rt.graph.children.get(target.agent);
    const parent = rt.graph.byName.get(target.actorAgent);
    if (!childAgent || !parent)
        return forbidden;
    if (!(await interactionAuthorized(rt, ctx, args.op, target, text)))
        return forbidden;
    if (args.op === "message")
        return messageChild(rt, ctx, args, target, childAgent, text);
    return askParent(rt, ctx, args, target, childAgent, text);
}
/**
 * Reuse background launch/delivery policy, with trusted persisted identities:
 * a parent message is a `delegate` (it adds work to the child), a child question
 * is a `deliver` (it posts into the parent). A throw or another subject denies.
 * All native writes and admission share this transaction.
 */
async function interactionAuthorized(rt, ctx, op, target, text) {
    try {
        const authorized = await rt.config.authorize(ctx, op === "message"
            ? {
                operation: "delegate",
                agent: target.rootAgent,
                threadId: target.rootThreadId,
                subject: target.subject,
                rootAssignmentId: target.rootAssignmentId,
                rootAgent: target.rootAgent,
                actorAgent: target.actorAgent,
                childAgent: target.agent,
                task: text,
            }
            : {
                operation: "deliver",
                agent: target.rootAgent,
                threadId: target.rootThreadId,
                subject: target.subject,
                rootAssignmentId: target.rootAssignmentId,
                rootAgent: target.rootAgent,
                actorAgent: target.actorAgent,
                childAgent: target.agent,
                runId: target.runId,
            });
        return authorized.subject === target.subject;
    }
    catch {
        return false;
    }
}
/** Save the parent's follow-up as a user prompt on the child thread and admit it. */
async function messageChild(rt, ctx, args, target, childAgent, text) {
    const { messageId } = await saveTrackedMessage(rt, ctx, childAgent.component, {
        threadId: target.childThreadId,
        prompt: text,
        userId: target.subject,
    });
    return ctx.runMutation(rt.component.subagents.messages.messageChild, {
        assignmentId: args.assignmentId,
        turnToken: args.turnToken,
        runId: args.runId,
        messageId,
    });
}
/**
 * Save the child's question (assistant message on the child thread) and its
 * parent-facing copy, admit both, then verify the recorded question id against
 * the child transcript. An unverifiable question throws and rolls back the
 * whole transaction.
 */
async function askParent(rt, ctx, args, target, childAgent, text) {
    const { messageId: questionMessageId } = await saveMessage(ctx, childAgent.component, {
        threadId: target.childThreadId,
        agentName: target.agent,
        message: { role: "assistant", content: text },
    });
    const parentAgent = rt.graph.byName.get(target.parentAgent);
    if (!parentAgent)
        throw new Error("FORBIDDEN");
    const { messageId: parentMessageId } = await saveTrackedMessage(rt, ctx, parentAgent.component, {
        threadId: target.parentThreadId,
        prompt: target.agent + " asks (run " + target.runId + "):\n\n" + text,
        agentName: target.agent,
        userId: target.subject,
    });
    const response = await ctx.runMutation(rt.component.subagents.messages.askParent, {
        assignmentId: args.assignmentId,
        turnToken: args.turnToken,
        questionMessageId,
        parentMessageId,
    });
    const recorded = await ctx.runQuery(rt.component.subagents.messages.questionContext, {
        runId: target.runId,
    });
    if (!recorded ||
        !(await verifyChildMessage(rt, ctx, {
            threadId: target.childThreadId,
            agentName: target.agent,
            messageId: recorded,
            subject: target.subject,
        })))
        throw new Error("RESULT_UNVERIFIED");
    return response;
}
