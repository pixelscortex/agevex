// The coordinator's `launch` op: start one delegated child run (or side review).
//
// Called from the managed `agevex_delegate` tool and from the turn runner's side
// reviews (`turn/completion.ts`), always through the coordinator mutation, so
// every step below shares one transaction: capability check
// (`subagents.launch.delegateContext`), graph permission, host `delegate` policy, side
// review admission (`hooks.reviews.reviewContext`), idempotent reservation
// (`subagents.launch.reserve`), then, for a fresh reservation only, the native child
// thread, its first prompt and `subagents.launch.attach`. A replayed tool call returns
// the original run and never creates a second child thread.
import { createThread } from "@convex-dev/agent";
import { createFunctionHandle } from "convex/server";
import { LIMITS } from "../../component/limits.js";
import { taskPreview } from "../../component/run-tree-values.js";
import { savedMessageRef, saveTrackedMessage } from "../native-saves.js";
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
    if (!mayLaunch(rt, owned, args))
        return denied("FORBIDDEN");
    if (!(await launchAuthorized(rt, ctx, owned, args.agent, task)))
        return denied("FORBIDDEN");
    const child = rt.graph.children.get(args.agent);
    if (!child)
        return denied("FORBIDDEN");
    const side = args.side ? sideAgentFor(rt, owned, args.agent) : undefined;
    const review = side
        ? await ctx.runQuery(rt.component.hooks.reviews.reviewContext, {
            assignmentId: args.assignmentId,
            executionId: args.turnToken,
            agent: args.agent,
            ...side.every,
        })
        : null;
    if (args.side && !review)
        return denied("RUN_BUDGET");
    const reservation = await reserveRun(rt, ctx, args, owned, task);
    if (reservation.kind === "denied") {
        return { status: "denied", code: reservation.code };
    }
    if (reservation.kind === "replay")
        return { status: "queued", runId: reservation.runId, agent: args.agent };
    // Only a fresh reservation reaches the native writes, so a replay
    // can never create a second child thread. Everything below runs in
    // this same transaction as `reserve`.
    const childTask = review ? await withReviewDelta(rt, ctx, args, owned, review, task) : task;
    await startChildThread(rt, ctx, child, owned, reservation.runId, childTask);
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
/** Graph permission: a declared side agent for side launches, else a declared child edge. */
function mayLaunch(rt, owned, args) {
    return args.side
        ? !!rt.graph.byName
            .get(owned.actorAgent)
            ?.sideAgents?.some((side) => side.agent.name === args.agent)
        : !!rt.graph.edges.get(owned.actorAgent)?.has(args.agent);
}
function sideAgentFor(rt, owned, agent) {
    return rt.graph.byName
        .get(owned.actorAgent)
        ?.sideAgents?.find((side) => side.agent.name === agent);
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
        payloadFingerprint: await fingerprint([
            owned.actorAgent,
            args.agent,
            task,
            args.group ?? null,
            args.wait ?? "each",
        ]),
        group: args.group,
        wait: args.wait,
        side: args.side,
        coordinateHandle: await createFunctionHandle(rt.config.refs.coordinate()),
    });
}
/**
 * Append the watched conversation delta to a side review's task and advance the
 * review boundary (`hooks.reviews.reviewed`) in the same transaction.
 */
async function withReviewDelta(rt, ctx, args, owned, review, task) {
    // Exact identities captured with native writes; no listMessages.
    // Metadata admits <=2 MiB of source docs; text-only output is
    // UTF-8 clipped to 48 KiB. Tools/reasoning never enter the fork.
    const parent = rt.graph.byName.get(owned.actorAgent);
    const docs = await ctx.runQuery(parent.component.messages.getMessagesByIds, {
        messageIds: review.refs.map((ref) => ref.id),
    });
    const childTask = task + "\n\n" + clipReviewDelta(docs).join("\n");
    await ctx.runMutation(rt.component.hooks.reviews.reviewed, {
        assignmentId: args.assignmentId,
        executionId: args.turnToken,
        agent: args.agent,
        boundary: review.boundary,
    });
    return childTask;
}
/**
 * Newest-first text-only projection of the delta, clipped to
 * `LIMITS.contextBytes` UTF-8 bytes in total, returned oldest first.
 */
function clipReviewDelta(docs) {
    let remaining = LIMITS.contextBytes;
    const chunks = [];
    for (const doc of docs.reverse()) {
        if (!doc || !["user", "assistant"].includes(doc.message?.role ?? "") || remaining <= 0)
            continue;
        const bytes = new TextEncoder().encode(`${doc.message.role}: ${doc.text ?? ""}`);
        // stream:true drops an incomplete trailing UTF-8 code point;
        // replacement characters must not push output over the cap.
        const chunk = new TextDecoder().decode(bytes.slice(0, remaining), {
            stream: true,
        });
        chunks.unshift(chunk);
        remaining -= new TextEncoder().encode(chunk).byteLength + 1;
    }
    return chunks;
}
/**
 * Create the child's native thread, save its first prompt at the reserved
 * first-prompt order, and attach both exact ids to the run.
 */
async function startChildThread(rt, ctx, child, owned, runId, childTask) {
    const threadId = await createThread(ctx, child.component, { userId: owned.subject });
    const { messageId, message } = await saveTrackedMessage(rt, ctx, child.component, {
        threadId,
        prompt: childTask,
        order: LIMITS.firstPromptOrder,
        userId: owned.subject,
    });
    await ctx.runMutation(rt.component.subagents.launch.attach, {
        runId,
        childThreadId: threadId,
        promptMessageId: messageId,
        task: taskPreview(childTask),
        trackContext: !!child.sideAgents?.length,
        savedMessage: savedMessageRef(messageId, message),
    });
}
