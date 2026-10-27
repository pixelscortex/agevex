/** One reactive, request-scoped run tree. Native Agent owns all message bodies.
 * D = HOST_LIMITS.runLaunches.max = 50.
 * (1+D)*13 KiB assignments +D*4 KiB children +3*13 KiB ownership
 * +13 KiB root assignment +16 KiB run metadata +1 KiB ready probe = 932 KiB core reads.
 * Any app usage projection is responsible for its own bounded reads.
 * The host checks both Convex and JSON output bytes against 128 KiB.
 * No per-node transcript or settlement scans: reuse the already bounded
 * child set to project transitive delivery fences in memory.
 */
import { approvalBlocked } from "../approvals.js";
import type { Doc } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import { TREE_LIMITS, type RunNode, type RunTree } from "../run_tree_values.js";
import { readyForRun } from "../turns/run_lifecycle.js";
import { runTimes } from "./runs.js";

type State = Pick<RunNode, "status" | "reason" | "error">;

/** The id must belong to this persisted root, including explicit history reads. */
async function selectedRun(ctx: QueryCtx, root: Doc<"assignments">, rootRunId?: string) {
  const id = rootRunId === undefined ? root.runId : ctx.db.normalizeId("runs", rootRunId);

  if (rootRunId !== undefined && !id) throw new Error("FORBIDDEN");

  const run = id
    ? await ctx.db.get("runs", id)
    : await ctx.db
        .query("runs")
        .withIndex("by_root", (q) => q.eq("rootAssignmentId", root._id))
        .order("desc")
        .first();

  if (run && run.rootAssignmentId !== root._id) throw new Error("FORBIDDEN");

  return run;
}

/** All rows share the root budget, whose immutable limits bounded reservation.
 * Hard ceilings are derived centrally rather than trusting query arguments.
 */
export async function requestTree(
  ctx: QueryCtx,
  root: Doc<"assignments">,
  rootRunId?: string,
): Promise<RunTree> {
  const run = await selectedRun(ctx, root, rootRunId);

  if (!run) return null;

  const children = await ctx.db
    .query("subagentRuns")
    .withIndex("by_parent_run", (q) => q.eq("parentRunId", run._id))
    .take(TREE_LIMITS.descendants);

  children.sort((a, b) => a.sequence - b.sequence);
  const assignments = new Map<string, Doc<"assignments">>([[root._id, root]]);
  const parents = new Map<string, string>([[root._id, run._id]]);
  const blocked = new Set<string>();

  for (const child of children) {
    if (child.childAssignmentId) {
      parents.set(child.childAssignmentId, child._id);
      const assignment = await ctx.db.get("assignments", child.childAssignmentId);

      if (assignment) assignments.set(assignment._id, assignment);
    }

    if (child.deliveryStatus === "pending") blocked.add(child.actorAssignmentId);
  }

  const ready = await readyForRun(ctx, root._id, run._id);
  const state = rootState(root, run, blocked.has(root._id), !!ready);

  const nodes: RunNode[] = [
    {
      id: run._id,
      parentId: null,
      agent: root.agent,
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

  for (const child of children) nodes.push(childNode(child, assignments, parents, blocked));

  return { rootRunId: String(run._id), usage: null, nodes };
}

/** Terminal run facts win over mutable assignment state, including later sends. */
function rootState(
  root: Doc<"assignments">,
  run: Doc<"runs">,
  blocked: boolean,
  ready: boolean,
): State {
  if (
    run.cancelled ||
    (run.finishedAt === undefined &&
      run.rootCancellationEpoch !== undefined &&
      run.rootCancellationEpoch !== root.cancellationEpoch)
  )
    return { status: "failed", reason: "cancelled" };

  if (run.errorCode) return failure(run.errorCode);

  if (run.finishedAt !== undefined) return { status: "done" };

  if (root.runId === run._id) {
    const state = assignmentState(root);

    if (state) return state;
  }

  if (blocked) return { status: "asleep", reason: "children" };

  if (ready || run.startedAt === undefined) return { status: "queued" };

  return { status: "asleep" };
}

/** An idle assignment is never sufficient evidence of successful closure. */
function assignmentState(row?: Doc<"assignments">): State | null {
  if (!row) return null;

  if (row.cancelled) return { status: "failed", reason: "cancelled" };

  if (approvalBlocked(row))
    return {
      status: "asleep",
      reason: row.approvals?.requests.some((request) => !request.deferred && !request.resolved)
        ? "approval"
        : "ask",
    };

  if (row.turnStatus === "recovery_required") return failure(row.errorCode);

  if (row.turnStatus === "queued" || row.turnStatus === "running")
    return { status: row.turnStatus };

  return null;
}

function failure(error: Doc<"assignments">["errorCode"]): State {
  return {
    status: error === "BUDGET_EXCEEDED" ? "asleep" : "failed",
    reason: error === "BUDGET_EXCEEDED" ? "budget" : "recovery",
    ...(error ? { error } : {}),
  };
}

/** A stored terminal delegation is authoritative even before turn cleanup. */
function childNode(
  run: Doc<"subagentRuns">,
  assignments: Map<string, Doc<"assignments">>,
  parents: Map<string, string>,
  blocked: Set<string>,
): RunNode {
  const row = run.childAssignmentId ? assignments.get(run.childAssignmentId) : undefined;

  const state: State =
    run.status === "completed"
      ? { status: "done" }
      : run.status === "failed"
        ? {
            status: "failed",
            ...(row?.cancelled ? { reason: "cancelled" as const } : {}),
            ...(run.errorCode ? { error: run.errorCode } : {}),
          }
        : run.status === "asking"
          ? { status: "asleep", reason: "ask" }
          : (assignmentState(row) ??
            (row && blocked.has(row._id)
              ? { status: "asleep", reason: "children" }
              : { status: run.status === "queued" ? "queued" : "asleep" }));

  return {
    id: run._id,
    parentId: parents.get(run.actorAssignmentId)!,
    agent: run.agent,
    ...state,
    createdAt: run._creationTime,
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
function currentTool(row: Doc<"assignments"> | undefined, state: State) {
  return state.status === "running" && row?.lastSlice?.active
    ? (row.activeTools?.[row.activeTools.length - 1]?.name ?? null)
    : null;
}
