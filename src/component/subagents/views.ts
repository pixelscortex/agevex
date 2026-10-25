/**
 * Read-only delegation views for the host.
 *
 * Trusted contexts for a running turn: `delegateScope` (may it delegate, and
 * under which root: `subagents.launch.delegateContext`), `settlementScope` (what a
 * finishing child needs to verify its result: `subagents.settle.settlementContext`)
 * and `terminalContext` (what the coordinator needs to deliver a finished
 * run: `subagents.deliver.deliveryContext`). Public views: `delegationPage` (the
 * root's paginated history) and `requestTree` (the current request's tree).
 * Only small coordination fields cross the query boundary: no transcript
 * bodies, and capabilities only to the turn or coordinator that owns them.
 */
import { v } from "convex/values";
import type { PaginationOptions } from "convex/server";
import type { QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { runErrorCode } from "../schema.js";
import { LIMITS } from "../limits.js";
import { runById } from "./runs.js";
import { settlementBlocked } from "./settle.js";

/** The root context of a running turn that wants to delegate: who the root
 * is and how many children it already has live. Null for stale turns. */
export async function delegateScope(
  ctx: QueryCtx,
  args: { assignmentId: Id<"assignments">; turnToken: string },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);
  if (!row || row.turnToken !== args.turnToken || row.turnStatus !== "running") return null;
  if (row.cancelled) return null;

  const root = row.rootAssignmentId ? await ctx.db.get("assignments", row.rootAssignmentId) : row;
  if (!root || root.cancelled) return null;

  return {
    rootAssignmentId: root._id,
    rootThreadId: root.threadId,
    subject: row.subject,
    rootAgent: root.agent,
    actorAgent: row.agent,
    activeRuns: root.activeRuns,
  };
}

/**
 * What a finishing child turn needs before it reports its outcome: the run it
 * is finishing, the child's recorded final assistant message (written by
 * turns.slices.write in the same transaction as the native save), and whether the
 * settlement fence still holds (`blocked`: pending inbox work, descendants or
 * an unjoined cohort). The host uses it to verify the result before calling
 * `settle`. Null unless this exact turn token still owns a running child turn
 * whose run is live and attached to it, so a stale or cancelled action can
 * never settle a run it no longer owns.
 */
export async function settlementScope(
  ctx: QueryCtx,
  args: { assignmentId: Id<"assignments">; turnToken: string; runId: string },
) {
  const child = await ctx.db.get("assignments", args.assignmentId);
  if (!child || child.childRunId !== args.runId || child.turnToken !== args.turnToken) return null;
  if (child.cancelled || child.turnStatus !== "running") return null;

  const run = await runById(ctx, args.runId);
  // The run must still be the one this child turn claimed, and still be the
  // non-terminal run it is allowed to finish.
  if (!run || run.childAssignmentId !== child._id || run.status !== "running") return null;
  if (!run.childThreadId) return null;

  return {
    runId: run.runId,
    agent: run.agent,
    subject: child.subject,
    childThreadId: run.childThreadId,
    childResultMessageId: run.childResultMessageId ?? null,
    blocked: await settlementBlocked(ctx, child),
  };
}

export const deliveryContextFields = {
  runId: v.string(),
  agent: v.string(),
  rootAgent: v.string(),
  parentAgent: v.string(),
  parentThreadId: v.string(),
  actorAgent: v.string(),
  subject: v.string(),
  rootAssignmentId: v.string(),
  rootThreadId: v.string(),
  childThreadId: v.string(),
  childResultMessageId: v.union(v.string(), v.null()),
  status: v.union(v.literal("completed"), v.literal("failed")),
  errorCode: runErrorCode,
  rootAvailable: v.boolean(),
  side: v.optional(v.boolean()),
} as const;

/** Everything the coordinator needs to deliver a terminal, undelivered run:
 * the threads and agents on both ends, the verified child result id, and
 * whether the parent side can still accept it (`rootAvailable`). Null when
 * the run is not terminal, already delivered, or its root/parent is gone. */
export async function terminalContext(ctx: QueryCtx, run: Doc<"subagentRuns">) {
  if (run.status !== "completed" && run.status !== "failed") return null;
  if (run.deliveryStatus !== "pending") return null;

  const root = await ctx.db.get("assignments", run.rootAssignmentId);
  const parent = await ctx.db.get("assignments", run.actorAssignmentId);
  if (!root || !parent) return null;

  return {
    runId: run.runId,
    side: run.side,
    agent: run.agent,
    rootAgent: root.agent,
    parentAgent: parent.agent,
    actorAgent: run.actorAgent,
    subject: root.subject,
    rootAssignmentId: root._id,
    rootThreadId: root.threadId,
    parentThreadId: parent.threadId,
    childThreadId: run.childThreadId ?? "",
    childResultMessageId: run.childResultMessageId ?? null,
    status: run.status,
    errorCode: run.errorCode,
    rootAvailable:
      !root.cancelled &&
      !parent.cancelled &&
      parent.turnStatus !== "recovery_required" &&
      root.cancellationEpoch === run.rootCancellationEpoch &&
      root.turnStatus !== "recovery_required",
  };
}

/** Delegation page cursors are the last returned root-wide `sequence`. */
function decodeCursor(cursor: string | null): number | null {
  if (!cursor) return null;

  const sequence = Number(cursor);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("INVALID_CURSOR");
  return sequence;
}

/** One page of the root's delegation history, newest first, paginated by
 * the root-wide reservation sequence. */
export async function delegationPage(
  ctx: QueryCtx,
  root: Doc<"assignments">,
  paginationOpts: PaginationOptions,
) {
  const size = Math.min(Math.max(1, paginationOpts.numItems), LIMITS.maxDelegationPage);
  const cursor = decodeCursor(paginationOpts.cursor);
  // <=51 metadata rows *4 KiB + ownership/root metadata <256 KiB;
  // at most 55 document reads, independent of accumulated history.
  const rows = await ctx.db
    .query("subagentRuns")
    .withIndex("by_root_sequence", (q) =>
      cursor === null
        ? q.eq("rootAssignmentId", root._id)
        : q.eq("rootAssignmentId", root._id).lt("sequence", cursor),
    )
    .order("desc")
    .take(size + 1);

  const page = rows.slice(0, size);
  return {
    page: page.map(delegationView),
    isDone: rows.length <= size,
    continueCursor: page.length ? String(page[page.length - 1].sequence) : "",
  };
}

/** The current root request's tree. Only small coordination fields cross the
 * query boundary; no transcript bodies or execution capabilities are exposed.
 * <=58 model/side launch rows *4 KiB + <=32 KiB root metadata <288 KiB,
 * <64 document reads.
 *
 * A run budget belongs to exactly one root: accept creates it for that root's
 * request, and every descendant inherits it (attach copies the parent run id;
 * every inbox row a descendant can claim carries it), while reserve writes
 * parentRunId = actor.runId with rootAssignmentId = the actor's root. So the
 * parentRunId prefix of by_group is exactly the old (root, run) range. Its size
 * is launches + sideRuns of that budget: only reserve increments either, by
 * one per insert, after refusing at runLaunches / sideRunsPerRun (row.limits,
 * copied from this root and never patched). The take therefore returns every
 * row, and sorting by sequence restores reservation order.
 */
export async function requestTree(ctx: QueryCtx, root: Doc<"assignments">) {
  if (!root.runId) return [];

  const rows = await ctx.db
    .query("subagentRuns")
    .withIndex("by_group", (q) => q.eq("parentRunId", root.runId!))
    .take(root.limits.runLaunches + root.limits.sideRunsPerRun);
  rows.sort((a, b) => a.sequence - b.sequence);
  return rows.map(treeNode);
}

/** One run in the public delegation history (`schema.subagentRun`). */
function delegationView(run: Doc<"subagentRuns">) {
  return {
    runId: run.runId,
    side: run.side ?? false,
    // Defensively preserve absence between reservation and attachment,
    // or on older rows, even though the coordinator commits both together.
    childThreadId: run.childThreadId ?? null,
    agent: run.agent,
    status: run.status,
    deliveryStatus: run.deliveryStatus,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    deliveryAt: run.deliveryAt ?? null,
    resultMessageId: run.resultMessageId ?? null,
    errorCode: run.errorCode,
    events: run.events.map((event) => ({
      runId: run.runId,
      agent: run.agent,
      ...event,
    })),
  };
}

/** One node of the current request's delegation tree. */
function treeNode(run: Doc<"subagentRuns">) {
  return {
    runId: run.runId,
    side: run.side ?? false,
    parentAssignmentId: run.actorAssignmentId,
    childAssignmentId: run.childAssignmentId ?? null,
    agent: run.agent,
    status: run.status,
    depth: run.depth,
    group: run.group ?? null,
    childThreadId: run.childThreadId ?? null,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
  };
}
