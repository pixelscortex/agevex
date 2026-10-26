import { TREE_LIMITS } from "../run-tree-values.js";
import { readyForRun } from "../turns/run-lifecycle.js";
import { runTimes } from "./runs.js";
/** The id must belong to this persisted root, including explicit history reads. */
async function selectedRun(ctx, root, rootRunId) {
    const id = rootRunId === undefined ? root.runId : ctx.db.normalizeId("runs", rootRunId);
    if (rootRunId !== undefined && !id)
        throw new Error("FORBIDDEN");
    const run = id
        ? await ctx.db.get("runs", id)
        : await ctx.db
            .query("runs")
            .withIndex("by_root", (q) => q.eq("rootAssignmentId", root._id))
            .order("desc")
            .first();
    if (run && run.rootAssignmentId !== root._id)
        throw new Error("FORBIDDEN");
    return run;
}
/** All rows share the root budget, whose immutable limits bounded reservation.
 * Hard ceilings are derived centrally rather than trusting query arguments.
 */
export async function requestTree(ctx, root, rootRunId) {
    const run = await selectedRun(ctx, root, rootRunId);
    if (!run)
        return null;
    const children = await ctx.db
        .query("subagentRuns")
        .withIndex("by_group", (q) => q.eq("parentRunId", run._id))
        .take(TREE_LIMITS.descendants);
    children.sort((a, b) => a.sequence - b.sequence);
    const assignments = new Map([[root._id, root]]);
    const parents = new Map([[root._id, run._id]]);
    const blocked = new Set();
    for (const child of children) {
        if (child.childAssignmentId) {
            parents.set(child.childAssignmentId, child.runId);
            const assignment = await ctx.db.get("assignments", child.childAssignmentId);
            if (assignment)
                assignments.set(assignment._id, assignment);
        }
        if (!child.side &&
            (child.deliveryStatus === "pending" || (child.join && child.join !== "joined")))
            blocked.add(child.actorAssignmentId);
    }
    const ready = await readyForRun(ctx, root._id, run._id);
    const state = rootState(root, run, blocked.has(root._id), !!ready);
    const nodes = [
        {
            id: run._id,
            parentId: null,
            agent: root.agent,
            task: run.taskPreview ?? "",
            ...state,
            createdAt: run._creationTime,
            startedAt: run.startedAt ?? null,
            finishedAt: run.finishedAt ?? null,
            currentTool: root.runId === run._id ? currentTool(root, state) : null,
            usage: null,
            messages: {
                threadId: root.threadId,
                taskId: run.taskMessageId,
                resultId: run.resultMessageId,
            },
        },
    ];
    for (const child of children)
        nodes.push(childNode(child, assignments, parents, blocked));
    return { rootRunId: String(run._id), usage: null, nodes };
}
/** Terminal run facts win over mutable assignment state, including later sends. */
function rootState(root, run, blocked, ready) {
    if (run.cancelled ||
        (run.finishedAt === undefined &&
            run.rootCancellationEpoch !== undefined &&
            run.rootCancellationEpoch !== root.cancellationEpoch))
        return { status: "failed", reason: "cancelled" };
    if (run.errorCode)
        return failure(run.errorCode);
    if (run.finishedAt !== undefined)
        return { status: "done" };
    if (root.runId === run._id) {
        const state = assignmentState(root);
        if (state)
            return state;
    }
    if (blocked)
        return { status: "asleep", reason: "children" };
    if (ready || run.startedAt === undefined)
        return { status: "queued" };
    return { status: "asleep" };
}
/** An idle assignment is never sufficient evidence of successful closure. */
function assignmentState(row) {
    if (!row)
        return null;
    if (row.cancelled)
        return { status: "failed", reason: "cancelled" };
    if (row.approvalBlocked)
        return {
            status: "asleep",
            reason: row.approvals?.requests.some((request) => !request.deferred && !request.resolved)
                ? "approval"
                : "ask",
        };
    if (row.turnStatus === "recovery_required")
        return failure(row.errorCode);
    if (row.turnStatus === "queued" || row.turnStatus === "running")
        return { status: row.turnStatus };
    return null;
}
function failure(error) {
    return {
        status: error === "BUDGET_EXCEEDED" ? "asleep" : "failed",
        reason: error === "BUDGET_EXCEEDED" ? "budget" : "recovery",
        ...(error ? { error } : {}),
    };
}
/** A stored terminal delegation is authoritative even before turn cleanup. */
function childNode(run, assignments, parents, blocked) {
    const row = run.childAssignmentId ? assignments.get(run.childAssignmentId) : undefined;
    const state = run.status === "completed"
        ? { status: "done" }
        : run.status === "failed"
            ? {
                status: "failed",
                ...(row?.cancelled ? { reason: "cancelled" } : {}),
                ...(run.errorCode ? { error: run.errorCode } : {}),
            }
            : run.status === "asking"
                ? { status: "asleep", reason: "ask" }
                : (assignmentState(row) ??
                    (row && blocked.has(row._id)
                        ? { status: "asleep", reason: "children" }
                        : { status: run.status === "queued" ? "queued" : "asleep" }));
    return {
        id: run.runId,
        parentId: parents.get(run.actorAssignmentId),
        agent: run.agent,
        task: run.taskPreview ?? "",
        ...state,
        createdAt: run.createdAt,
        startedAt: run.startedAt ?? null,
        finishedAt: runTimes(run).finishedAt,
        currentTool: currentTool(row, state),
        usage: null,
        messages: {
            threadId: run.childThreadId ?? "",
            taskId: run.taskMessageId,
            resultId: run.childResultMessageId,
            parentResultId: run.resultMessageId,
            questionId: run.questionMessageId,
        },
    };
}
/** Progress is visible only while the same assignment is actively running. */
function currentTool(row, state) {
    return state.status === "running" && row?.watchdogId
        ? (row.activeTools?.[row.activeTools.length - 1]?.name ?? null)
        : null;
}
