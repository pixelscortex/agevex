import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  mutation,
  query,
  internalAction,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import type { FunctionReference } from "convex/server";
import { wake } from "./queue.js";
import { denialCode, runErrorCode, subagentRun, vPaginationResult } from "./schema.js";
import { LIMITS } from "./limits.js";

const reservation = v.union(
  v.object({ kind: v.literal("reserved"), runId: v.string() }),
  v.object({ kind: v.literal("replay"), runId: v.string(), agent: v.string() }),
  v.object({ kind: v.literal("denied"), code: denialCode }),
);

const deliveryContextFields = {
  runId: v.string(),
  agent: v.string(),
  rootAgent: v.string(),
  actorAgent: v.string(),
  subject: v.string(),
  rootAssignmentId: v.string(),
  rootThreadId: v.string(),
  childThreadId: v.string(),
  childResultMessageId: v.union(v.string(), v.null()),
  status: v.union(v.literal("completed"), v.literal("failed")),
  errorCode: runErrorCode,
  rootAvailable: v.boolean(),
} as const;

async function runById(ctx: QueryCtx | MutationCtx, runId: string) {
  return ctx.db
    .query("subagentRuns")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

function appendEvent(
  events: Doc<"subagentRuns">["events"],
  phase: Doc<"subagentRuns">["events"][number]["phase"],
  at: number,
  errorCode: Doc<"subagentRuns">["errorCode"],
) {
  return [...events, { phase, at, errorCode }].slice(-LIMITS.runEvents);
}

async function settleRunState(
  ctx: MutationCtx,
  run: Doc<"subagentRuns">,
  status: "completed" | "failed",
  errorCode: Doc<"subagentRuns">["errorCode"],
  childResultMessageId: string | undefined,
) {
  if (run.status === "completed" || run.status === "failed") return false;
  const at = Date.now();
  await ctx.db.patch("subagentRuns", run._id, {
    status,
    errorCode,
    finishedAt: at,
    ...(childResultMessageId ? { childResultMessageId } : {}),
    events: appendEvent(run.events, status, at, errorCode),
  });
  const root = await ctx.db.get("assignments", run.rootAssignmentId);
  if (root) {
    await ctx.db.patch("assignments", root._id, {
      activeRuns: Math.max(0, (root.activeRuns ?? 0) - 1),
      historyRuns: (root.historyRuns ?? 0) + 1,
    });
  }
  return true;
}

export const delegateContext = query({
  args: { assignmentId: v.id("assignments"), turnToken: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      rootAssignmentId: v.string(),
      rootThreadId: v.string(),
      subject: v.string(),
      rootAgent: v.string(),
      actorAgent: v.string(),
      activeRuns: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.turnToken !== args.turnToken || row.turnStatus !== "running") return null;
    if (row.cancelled || row.childRunId || row.rootAssignmentId) return null;
    return {
      rootAssignmentId: row._id,
      rootThreadId: row.threadId,
      subject: row.subject,
      rootAgent: row.agent,
      actorAgent: row.agent,
      activeRuns: row.activeRuns ?? 0,
    };
  },
});

/**
 * Reservation, run-budget spend and active-child count commit with the host's
 * native child thread creation. Dedup precedes admission limits so a repeated
 * callback can recover its original receipt even at capacity. Result turns
 * retain the originating user run; only a new user prompt creates new budget.
 * Depth stays one because only persisted root assignments can reserve.
 */
export const reserve = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    toolCallId: v.string(),
    agent: v.string(),
    payloadFingerprint: v.string(),
    coordinateHandle: v.string(),
    runTurn: v.string(),
  },
  returns: reservation,
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.turnToken !== args.turnToken || row.turnStatus !== "running")
      return { kind: "denied" as const, code: "STALE_TURN" as const };
    if (row.cancelled || row.childRunId || row.rootAssignmentId)
      return { kind: "denied" as const, code: "FORBIDDEN" as const };
    const dedupKey = `${row._id}:${args.turnToken}:${args.toolCallId}`;
    const duplicate = await ctx.db
      .query("subagentRuns")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", dedupKey))
      .unique();
    if (duplicate) {
      if (duplicate.payloadFingerprint !== args.payloadFingerprint)
        return { kind: "denied" as const, code: "DELEGATION_CONFLICT" as const };
      return { kind: "replay" as const, runId: duplicate.runId, agent: duplicate.agent };
    }
    if ((row.activeRuns ?? 0) >= LIMITS.activeChildrenPerRoot)
      return { kind: "denied" as const, code: "ACTIVE_LIMIT" as const };
    // A delivered-result turn retains this run id: completing a child cannot
    // replenish launches, and a new caller prompt alone creates a new budget.
    const budget = row.runId ? await ctx.db.get("runs", row.runId) : null;
    if (
      !budget ||
      budget.cancelled ||
      budget.launches >= LIMITS.runLaunches ||
      budget.hops >= LIMITS.runHops
    )
      return { kind: "denied" as const, code: "RUN_BUDGET" as const };
    await ctx.db.patch("runs", budget._id, {
      launches: budget.launches + 1,
      hops: budget.hops + 1,
      pendingResults: budget.pendingResults + 1,
    });
    const runId = crypto.randomUUID();
    const now = Date.now();
    const sequence = (row.nextRunSequence ?? 0) + 1;
    await ctx.db.insert("subagentRuns", {
      runId,
      rootCancellationEpoch: row.cancellationEpoch,
      parentRunId: budget._id,
      dedupKey,
      sequence,
      payloadFingerprint: args.payloadFingerprint,
      rootAssignmentId: row._id,
      actorAssignmentId: row._id,
      agent: args.agent,
      rootAgent: row.agent,
      actorAgent: row.agent,
      subject: row.subject,
      status: "queued",
      deliveryStatus: "pending",
      errorCode: null,
      deliveryToken: crypto.randomUUID(),
      coordinateHandle: args.coordinateHandle,
      runTurn: args.runTurn,
      createdAt: now,
      events: [{ phase: "queued", at: now, errorCode: null }],
    });
    await ctx.db.patch("assignments", row._id, {
      activeRuns: (row.activeRuns ?? 0) + 1,
      nextRunSequence: sequence,
    });
    return { kind: "reserved" as const, runId };
  },
});

/**
 * Queue a native child in its independent lane. Keeping the task in Agent and
 * only the message id in the inbox avoids placing task bodies in Workflow's
 * 800 KiB step values. The parent's short launch mutation never waits for a
 * child action, leaving scheduler capacity available for those children.
 */
export const attach = mutation({
  args: { runId: v.string(), childThreadId: v.string(), promptMessageId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (!run || run.childAssignmentId) return null;
    if (run.status !== "queued") throw new Error("INVALID_LAUNCH");
    const childId = await ctx.db.insert("assignments", {
      subject: run.subject,
      agent: run.agent,
      threadId: args.childThreadId,
      runTurn: run.runTurn,
      turnStatus: "idle",
      errorCode: null,
      queuedMessages: 1,
      nextSequence: 1,
      nextTurn: 0,
      cancellationEpoch: 0,
      cancelled: false,
      rootAssignmentId: run.rootAssignmentId,
      runId: run.parentRunId,
      childRunId: run.runId,
    });
    await ctx.db.insert("inbox", {
      assignmentId: childId,
      messageId: args.promptMessageId,
      sequence: 0,
      kind: "user",
      runId: run.parentRunId,
    });
    await ctx.db.patch("subagentRuns", run._id, {
      childAssignmentId: childId,
      childThreadId: args.childThreadId,
    });
    await wake(ctx, (await ctx.db.get("assignments", childId))!);
    return null;
  },
});

function notifyReference(handle: string) {
  return handle as unknown as FunctionReference<
    "mutation",
    "internal",
    { op: "notify"; runId: string; deliveryToken: string },
    null
  >;
}

export const settlementContext = query({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    runId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      runId: v.string(),
      agent: v.string(),
      subject: v.string(),
      childThreadId: v.string(),
      childResultMessageId: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const child = await ctx.db.get("assignments", args.assignmentId);
    if (!child || child.childRunId !== args.runId || child.turnToken !== args.turnToken)
      return null;
    if (child.cancelled || child.turnStatus !== "running") return null;
    const run = await runById(ctx, args.runId);
    // The run must still be the one this child turn claimed, and still be the
    // non-terminal run it is allowed to finish.
    if (!run || run.childAssignmentId !== child._id || run.status !== "running") return null;
    if (!run.childThreadId) return null;
    return {
      runId: run.runId,
      agent: run.agent,
      subject: run.subject,
      childThreadId: run.childThreadId,
      childResultMessageId: run.childResultMessageId ?? null,
    };
  },
});

export const deliveryContext = query({
  args: { runId: v.string(), deliveryToken: v.string() },
  returns: v.union(v.null(), v.object(deliveryContextFields)),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (!run || run.deliveryToken !== args.deliveryToken) return null;
    return terminalContext(ctx, run);
  },
});

async function terminalContext(ctx: QueryCtx, run: Doc<"subagentRuns">) {
  if (run.status !== "completed" && run.status !== "failed") return null;
  if (run.deliveryStatus !== "pending") return null;
  const root = await ctx.db.get("assignments", run.rootAssignmentId);
  if (!root) return null;
  return {
    runId: run.runId,
    agent: run.agent,
    rootAgent: run.rootAgent,
    actorAgent: run.actorAgent,
    subject: run.subject,
    rootAssignmentId: root._id,
    rootThreadId: root.threadId,
    childThreadId: run.childThreadId ?? "",
    childResultMessageId: run.childResultMessageId ?? null,
    status: run.status,
    errorCode: run.errorCode,
    rootAvailable:
      !root.cancelled &&
      root.cancellationEpoch === run.rootCancellationEpoch &&
      root.turnStatus !== "recovery_required",
  };
}

export const settle = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    runId: v.string(),
    childResultMessageId: v.union(v.string(), v.null()),
    errorCode: runErrorCode,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const child = await ctx.db.get("assignments", args.assignmentId);
    if (!child || child.childRunId !== args.runId || child.turnToken !== args.turnToken)
      throw new Error("FORBIDDEN");
    // A released or escalated turn cannot report an outcome any more.
    if (child.cancelled || child.turnStatus !== "running") throw new Error("FORBIDDEN");
    const run = await runById(ctx, args.runId);
    if (!run || run.childAssignmentId !== child._id) throw new Error("FORBIDDEN");
    await settleRunState(
      ctx,
      run,
      args.errorCode ? "failed" : "completed",
      args.errorCode,
      args.childResultMessageId ?? undefined,
    );
    return null;
  },
});

export const escalate = internalMutation({
  args: { runId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (!run) return null;
    const first = await settleRunState(ctx, run, "failed", "EXECUTION_AMBIGUOUS", undefined);
    if (!first) return null;
    await ctx.scheduler.runAfter(0, internal.subagents.notify, {
      runId: run.runId,
      deliveryToken: run.deliveryToken,
      coordinateHandle: run.coordinateHandle,
    });
    return null;
  },
});

export const notify = internalAction({
  args: { runId: v.string(), deliveryToken: v.string(), coordinateHandle: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(notifyReference(args.coordinateHandle), {
        op: "notify",
        runId: args.runId,
        deliveryToken: args.deliveryToken,
      });
    } catch {
      try {
        await ctx.runMutation(internal.subagents.failDelivery, {
          runId: args.runId,
          deliveryToken: args.deliveryToken,
        });
      } catch {
        // The delivery attempt and its failure record both failed to commit.
        // Nothing is claimed here: the run stays terminal and undelivered.
      }
    }
    return null;
  },
});

export const deliver = mutation({
  args: {
    runId: v.string(),
    deliveryToken: v.string(),
    deliveryStatus: v.union(v.literal("accepted"), v.literal("failed"), v.literal("blocked")),
    parentMessageId: v.union(v.string(), v.null()),
    errorCode: runErrorCode,
  },
  returns: v.null(),
  handler: (ctx, args) => applyDelivery(ctx, args),
});

export const failDelivery = internalMutation({
  args: { runId: v.string(), deliveryToken: v.string() },
  returns: v.null(),
  handler: (ctx, args) =>
    applyDelivery(ctx, {
      ...args,
      deliveryStatus: "failed",
      parentMessageId: null,
      errorCode: "DELIVERY_FAILED",
    }),
});

/** A terminal result spends a hop once, then the last delivery wakes the batch. */
async function applyDelivery(
  ctx: MutationCtx,
  args: {
    runId: string;
    deliveryToken: string;
    deliveryStatus: "accepted" | "failed" | "blocked";
    parentMessageId: string | null;
    errorCode: Doc<"subagentRuns">["errorCode"];
  },
) {
  const run = await runById(ctx, args.runId);
  if (!run || run.deliveryToken !== args.deliveryToken) throw new Error("FORBIDDEN");
  if (run.status !== "completed" && run.status !== "failed") throw new Error("INVALID_DELIVERY");
  if (run.deliveryStatus !== "pending") return null;
  const root = await ctx.db.get("assignments", run.rootAssignmentId);
  const at = Date.now();
  const phase = {
    accepted: "result_accepted",
    failed: "delivery_failed",
    blocked: "delivery_blocked",
  } as const;
  if (args.deliveryStatus === "accepted") {
    if (!args.parentMessageId || !root) throw new Error("INVALID_DELIVERY");
    if (
      root.cancelled ||
      root.cancellationEpoch !== run.rootCancellationEpoch ||
      root.turnStatus === "recovery_required"
    )
      throw new Error("ROOT_UNAVAILABLE");
  }
  await ctx.db.patch("subagentRuns", run._id, {
    deliveryStatus: args.deliveryStatus,
    deliveryAt: at,
    errorCode: args.errorCode ?? run.errorCode,
    ...(args.parentMessageId ? { resultMessageId: args.parentMessageId } : {}),
    events: appendEvent(run.events, phase[args.deliveryStatus], at, args.errorCode),
  });
  const budget = await ctx.db.get("runs", run.parentRunId);
  if (budget)
    await ctx.db.patch("runs", budget._id, {
      pendingResults: Math.max(0, budget.pendingResults - 1),
      hops: args.deliveryStatus === "accepted" ? budget.hops + 1 : budget.hops,
    });
  if (args.deliveryStatus !== "accepted" || !args.parentMessageId || !root) {
    if (root) await wake(ctx, root);
    return null;
  }
  const backlogged = {
    ...root,
    queuedMessages: root.queuedMessages + 1,
    nextSequence: root.nextSequence + 1,
  };
  if (root.queuedMessages >= LIMITS.queueLength) throw new Error("QUEUE_LIMIT");
  if (!budget || budget.cancelled || budget.hops >= LIMITS.runHops) throw new Error("RUN_BUDGET");
  await ctx.db.insert("inbox", {
    assignmentId: root._id,
    messageId: args.parentMessageId,
    sequence: root.nextSequence,
    kind: "result",
    runId: run.parentRunId,
  });
  await ctx.db.patch("assignments", root._id, {
    queuedMessages: backlogged.queuedMessages,
    nextSequence: backlogged.nextSequence,
  });
  await wake(ctx, backlogged);
  return null;
}

function decodeCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  const sequence = Number(cursor);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("INVALID_CURSOR");
  return sequence;
}

export const delegations = query({
  args: { threadId: v.string(), subject: v.string(), paginationOpts: paginationOptsValidator },
  returns: vPaginationResult(subagentRun),
  handler: async (ctx, args) => {
    const root = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!root || root.subject !== args.subject) throw new Error("FORBIDDEN");
    const size = Math.min(Math.max(1, args.paginationOpts.numItems), LIMITS.maxDelegationPage);
    const cursor = decodeCursor(args.paginationOpts.cursor);
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
      page: page.map((run) => ({
        runId: run.runId,
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
      })),
      isDone: rows.length <= size,
      continueCursor: page.length ? String(page[page.length - 1].sequence) : "",
    };
  },
});
