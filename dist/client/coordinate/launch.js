// Launch one delegated child atomically with its reservation, native thread and
// prompt. Replays return the original run without creating a second child.
import { createThread } from "@convex-dev/agent";
import { createFunctionHandle } from "convex/server";
import { LIMITS } from "../../component/limits.js";
import { saveMessage } from "@convex-dev/agent";
import { fingerprint } from "../once.js";
import { observe } from "../registration/context.js";
/**
 * Launch one child run for the actor's currently running turn.
 *
 * The caller's capability (assignment + running turn token + native tool call
 * id) is validated before any policy call or write; a denial is a tool result,
 * never a thrown error. Returns `queued` with the run id for a fresh launch and
 * for an idempotent replay of the same tool call.
 */
export async function launchChild(rt, ctx, args) {
    const task = args.task.trim();
    if (!task || task.length > rt.limits.taskLength)
        return denied("TASK_LIMIT");
    const owned = await ctx.runQuery(rt.component.subagents.launch.delegateContext, {
        assignmentId: args.assignmentId,
        turnToken: args.turnToken,
    });
    if (!owned)
        return denied("STALE_TURN");
    if (!rt.graph.edges.get(owned.actorAgent)?.has(args.agent))
        return denied("FORBIDDEN");
    if (!(await launchAuthorized(rt, ctx, owned, args.agent, task)))
        return denied("FORBIDDEN");
    const child = rt.graph.children.get(args.agent);
    if (!child)
        return denied("FORBIDDEN");
    const reservation = await reserveRun(rt, ctx, args, owned, task);
    if (reservation.kind === "denied") {
        return { status: "denied", code: reservation.code };
    }
    if (reservation.kind === "replay")
        return { status: "queued", runId: reservation.runId, agent: args.agent };
    // Only a fresh reservation reaches the native writes, so a replay
    // can never create a second child thread. Everything below runs in
    // this same transaction as `reserve`.
    await startChildThread(rt, ctx, child, owned, reservation.runId, task);
    await observe(rt, ctx, {
        type: "delegation.queued",
        runId: reservation.runId,
        rootAssignmentId: owned.rootAssignmentId,
        agent: args.agent,
    });
    return { status: "queued", runId: reservation.runId, agent: args.agent };
}
function denied(code) {
    return { status: "denied", code };
}
/**
 * Background `delegate` policy with persisted identities only. A throw or a
 * different subject both deny the launch.
 */
async function launchAuthorized(rt, ctx, owned, childAgent, task) {
    let subject = "";
    try {
        ({ subject } = await rt.config.authorize(ctx, {
            operation: "delegate",
            agent: owned.rootAgent,
            threadId: owned.rootThreadId,
            subject: owned.subject,
            rootAssignmentId: owned.rootAssignmentId,
            rootAgent: owned.rootAgent,
            actorAgent: owned.actorAgent,
            childAgent,
            task,
        }));
    }
    catch {
        subject = "";
    }
    return !!subject && subject === owned.subject;
}
/**
 * Reserve the run idempotently under the native tool call id. The payload
 * fingerprint makes a replay with a different payload a conflict rather than a
 * silent second launch.
 */
async function reserveRun(rt, ctx, args, owned, task) {
    return ctx.runMutation(rt.component.subagents.launch.reserve, {
        assignmentId: args.assignmentId,
        turnToken: args.turnToken,
        toolCallId: args.toolCallId,
        agent: args.agent,
        payloadFingerprint: await fingerprint([owned.actorAgent, args.agent, task]),
        coordinateHandle: await createFunctionHandle(rt.config.refs.coordinate()),
    });
}
/**
 * Create the child's native thread, save its first prompt at the reserved
 * first-prompt order, and attach both exact ids to the run.
 */
async function startChildThread(rt, ctx, child, owned, runId, childTask) {
    const threadId = await createThread(ctx, child.component, { userId: owned.subject });
    const { messageId } = await saveMessage(ctx, child.component, {
        threadId,
        prompt: childTask,
        order: LIMITS.firstPromptOrder,
        userId: owned.subject,
    });
    await ctx.runMutation(rt.component.subagents.launch.attach, {
        runId,
        childThreadId: threadId,
        promptMessageId: messageId,
    });
}
