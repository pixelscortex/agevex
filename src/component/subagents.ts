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
import { messageRef, recordRefs } from "./hooks.js";
import { approvalKey } from "./approvals.js";

const reservation = v.union(
  v.object({ kind: v.literal("reserved"), runId: v.string() }),
  v.object({ kind: v.literal("replay"), runId: v.string(), agent: v.string() }),
  v.object({ kind: v.literal("denied"), code: denialCode }),
);

const deliveryContextFields = {
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

async function runById(ctx: QueryCtx | MutationCtx, runId: string) {
  return ctx.db
    .query("subagentRuns")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

/** Every non-terminal child retains deliveryStatus=pending; delivery can only
 * change after settlement. One indexed existence probe therefore covers live
 * descendants AND the terminal-to-delivery gap. The fence is transitive because
 * a child obeys the same rule before settling. No history scan is needed.
 */
async function hasPendingChildren(
  ctx: QueryCtx | MutationCtx,
  parent: Doc<"assignments">,
  includeSide = false,
) {
  const ordinary = !!(await ctx.db
    .query("subagentRuns")
    .withIndex("by_parent_delivery", (q) =>
      q.eq("actorAssignmentId", parent._id).eq("side", undefined).eq("deliveryStatus", "pending"),
    )
    .first());
  if (ordinary || !includeSide) return ordinary;
  return !!(await ctx.db
    .query("subagentRuns")
    .withIndex("by_parent_delivery", (q) =>
      q.eq("actorAssignmentId", parent._id).eq("side", true).eq("deliveryStatus", "pending"),
    )
    .first());
}

/** A terminal child whose native delivery has not committed is also future
 * inbox work. Fence that short settlement/delivery interval and unreleased
 * groups as well as live descendants; otherwise a result could reach a terminal
 * parent. Five indexed existence probes (<=3 KiB inbox + 4*4 KiB runs)
 * + one <=32 KiB root
 * read stay below 52 KiB; no history is read.
 */
export async function settlementBlocked(ctx: QueryCtx | MutationCtx, parent: Doc<"assignments">) {
  if (
    await ctx.db
      .query("inbox")
      .withIndex("by_assignment_ready", (q) =>
        q.eq("assignmentId", parent._id).eq("passive", undefined),
      )
      .first()
  )
    return true;
  if (await hasPendingChildren(ctx, parent)) return true;
  const root = parent.rootAssignmentId
    ? await ctx.db.get("assignments", parent.rootAssignmentId)
    : parent;
  if (!root) return false;
  // Any not-yet-joined wait "all" member of this epoch fences settlement. One
  // exact probe per unjoined state, rather than a range over the join literal
  // order, so a renamed state can never silently fall outside the fence.
  for (const join of ["open", "sealed", "ready"] as const)
    if (
      await ctx.db
        .query("subagentRuns")
        .withIndex("by_join", (q) =>
          q
            .eq("actorAssignmentId", parent._id)
            .eq("rootCancellationEpoch", root.cancellationEpoch)
            .eq("join", join),
        )
        .first()
    )
      return true;
  return false;
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
  const child = run.childAssignmentId
    ? await ctx.db.get("assignments", run.childAssignmentId)
    : null;
  if (child && (await settlementBlocked(ctx, child))) return false;
  const at = Date.now();
  await ctx.db.patch("subagentRuns", run._id, {
    status,
    errorCode,
    // Only idle settlement reads the deferred outcome, and only before the run
    // is terminal; a terminal run never needs it again.
    lastTurnResult: undefined,
    finishedAt: at,
    ...(childResultMessageId ? { childResultMessageId } : {}),
    events: appendEvent(run.events, status, at, errorCode),
  });
  const root = await ctx.db.get("assignments", run.rootAssignmentId);
  if (root) {
    await ctx.db.patch("assignments", root._id, {
      activeRuns: Math.max(0, root.activeRuns - 1),
    });
  }
  // Side reviews never hold their watched parent behind R3, so their
  // settlement cannot clear an R3 blocker either. Only ordinary descendants
  // propagate this re-check; otherwise a best-effort review could finalize
  // an idle watched run before its own verified outcome is ready.
  if (!run.side) {
    const parent = await ctx.db.get("assignments", run.actorAssignmentId);
    if (parent) await settleIdleParent(ctx, parent);
  }
  return true;
}

/** R3 is an invariant, not just a turn-end check. Delivery failure and an
 * empty join can remove the last blocker without creating another turn. Use
 * only the host-verified outcome recorded by settle; a native save alone is
 * not proof that the last turn reported a valid result. The same notification
 * path propagates the terminal outcome to the next ancestor without paid work.
 * Depth <=2 bounds propagation to at most 2 * (6*32 KiB assignment reads +
 * 2*4 KiB run reads + 19 KiB indexed fence probes) <512 KiB metadata,
 * including patch reads and the watched thread's context references. No native
 * bodies are read here; side settlement never enters this ancestor path.
 */
export async function settleIdleParent(ctx: MutationCtx, parent: Doc<"assignments">) {
  if (parent.cancelled || parent.turnStatus !== "idle" || !parent.childRunId) return false;
  const run = await runById(ctx, parent.childRunId);
  if (!run || run.status === "asking") return false;
  if (run.status === "completed" || run.status === "failed") return true;
  const root = await ctx.db.get("assignments", run.rootAssignmentId);
  if (!root || root.cancelled || root.cancellationEpoch !== run.rootCancellationEpoch) return false;
  const result = run.lastTurnResult;
  const errorCode = result?.errorCode ?? (result?.messageId ? null : "RESULT_UNVERIFIED");
  if (
    !(await settleRunState(
      ctx,
      run,
      errorCode ? "failed" : "completed",
      errorCode,
      result?.messageId,
    ))
  )
    return false;
  await ctx.scheduler.runAfter(0, internal.subagents.notify, {
    runId: run.runId,
    deliveryToken: run.deliveryToken,
    coordinateHandle: run.coordinateHandle,
  });
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
  },
});

/**
 * Reservation, run-budget spend and active-child count commit with the host's
 * native child thread creation. Dedup precedes admission limits so a repeated
 * callback can recover its original receipt even at capacity. Result turns
 * retain the originating user run; only a new user prompt creates new budget.
 * Root counters include every descendant. Depth is checked from the immediate
 * parent run, so a shared child definition cannot bypass the configured bound.
 */
export const reserve = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    toolCallId: v.string(),
    agent: v.string(),
    payloadFingerprint: v.string(),
    coordinateHandle: v.string(),
    side: v.optional(v.boolean()),
    group: v.optional(v.string()),
    wait: v.optional(v.union(v.literal("each"), v.literal("all"))),
  },
  returns: reservation,
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.turnToken !== args.turnToken || row.turnStatus !== "running")
      return { kind: "denied" as const, code: "STALE_TURN" as const };
    const root = row.rootAssignmentId ? await ctx.db.get("assignments", row.rootAssignmentId) : row;
    const parent = row.childRunId ? await runById(ctx, row.childRunId) : null;
    if (
      row.cancelled ||
      !root ||
      root.cancelled ||
      (row.childRunId &&
        (!parent ||
          parent.status !== "running" ||
          parent.rootCancellationEpoch !== root.cancellationEpoch))
    )
      return { kind: "denied" as const, code: "FORBIDDEN" as const };
    const depth = parent ? parent.depth + 1 : 1;
    if (depth > root.limits.maxDepth)
      return { kind: "denied" as const, code: "DEPTH_LIMIT" as const };
    if (args.side && (args.group !== undefined || args.wait !== undefined))
      return { kind: "denied" as const, code: "GROUP_CONFLICT" as const };
    if ((args.group?.length ?? 0) > LIMITS.groupLength)
      return { kind: "denied" as const, code: "TASK_LIMIT" as const };
    const dedupKey = `${row._id}:${args.turnToken}:${await approvalKey(args.toolCallId)}`;
    const duplicate = await ctx.db
      .query("subagentRuns")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", dedupKey))
      .unique();
    if (duplicate) {
      if (duplicate.payloadFingerprint !== args.payloadFingerprint)
        return { kind: "denied" as const, code: "DELEGATION_CONFLICT" as const };
      return { kind: "replay" as const, runId: duplicate.runId, agent: duplicate.agent };
    }
    if (root.activeRuns >= root.limits.activeChildrenPerRoot)
      return { kind: "denied" as const, code: "ACTIVE_LIMIT" as const };
    // A delivered-result turn retains this run id: completing a child cannot
    // replenish launches, and a new caller prompt alone creates a new budget.
    const budget = row.runId ? await ctx.db.get("runs", row.runId) : null;
    if (
      !budget ||
      budget.cancelled ||
      (args.side
        ? budget.sideRuns >= row.limits.sideRunsPerRun
        : budget.launches >= row.limits.runLaunches || budget.hops >= row.limits.runHops)
    )
      return { kind: "denied" as const, code: "RUN_BUDGET" as const };
    const wait = args.wait ?? "each";
    const group = args.group ?? (wait === "all" ? "" : undefined);
    if (group !== undefined) {
      // A named group is a closed cohort, capped INCLUDING settled members.
      // <=15 small rows (<=4 KiB each) + two <=32 KiB assignments and fixed
      // admission metadata <160 KiB; no native
      // result bodies are read. Index scope excludes every other parent/run.
      const members = await ctx.db
        .query("subagentRuns")
        .withIndex("by_group", (q) =>
          q.eq("parentRunId", budget._id).eq("actorAssignmentId", row._id).eq("group", group),
        )
        .take(wait === "all" ? root.limits.activeChildrenPerRoot : 1);
      if (members.some((member) => (member.join ? "all" : "each") !== wait))
        return { kind: "denied" as const, code: "GROUP_CONFLICT" as const };
      // Sealing is one-way (sealed -> ready -> joined), so any state past
      // "open" means the launching slice already closed this cohort.
      if (members.some((member) => member.join && member.join !== "open"))
        return { kind: "denied" as const, code: "GROUP_CLOSED" as const };
      if (wait === "all" && members.length >= root.limits.activeChildrenPerRoot)
        return { kind: "denied" as const, code: "GROUP_LIMIT" as const };
    }
    await ctx.db.patch(
      "runs",
      budget._id,
      args.side
        ? { sideRuns: budget.sideRuns + 1 }
        : { launches: budget.launches + 1, hops: budget.hops + 1 },
    );
    const runId = crypto.randomUUID();
    const now = Date.now();
    const sequence = root.nextRunSequence + 1;
    await ctx.db.insert("subagentRuns", {
      runId,
      side: args.side || undefined,
      rootCancellationEpoch: root.cancellationEpoch,
      depth,
      messagesReceived: 0,
      group,
      ...(wait === "all" ? { join: "open" as const } : {}),
      parentRunId: budget._id,
      dedupKey,
      sequence,
      payloadFingerprint: args.payloadFingerprint,
      rootAssignmentId: root._id,
      actorAssignmentId: row._id,
      agent: args.agent,
      actorAgent: row.agent,
      status: "queued",
      deliveryStatus: "pending",
      errorCode: null,
      deliveryToken: crypto.randomUUID(),
      coordinateHandle: args.coordinateHandle,
      createdAt: now,
      events: [{ phase: "queued", at: now, errorCode: null }],
    });
    await ctx.db.patch("assignments", root._id, {
      activeRuns: root.activeRuns + 1,
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
  args: {
    runId: v.string(),
    childThreadId: v.string(),
    promptMessageId: v.string(),
    savedMessage: v.optional(messageRef),
    trackContext: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (!run || run.childAssignmentId) return null;
    if (run.status !== "queued") throw new Error("INVALID_LAUNCH");
    const root = await ctx.db.get("assignments", run.rootAssignmentId);
    if (!root || root.cancelled || root.cancellationEpoch !== run.rootCancellationEpoch)
      throw new Error("ROOT_UNAVAILABLE");
    const childId = await ctx.db.insert("assignments", {
      contextMessages: args.trackContext ? [] : undefined,
      subject: root.subject,
      agent: run.agent,
      threadId: args.childThreadId,
      runTurn: root.runTurn,
      limits: root.limits,
      turnStatus: "idle",
      errorCode: null,
      queuedMessages: 1,
      notesPending: 0,
      nextSequence: 1,
      nextTurn: 0,
      cancellationEpoch: 0,
      cancelled: false,
      completedTurns: 0,
      activeRuns: 0,
      nextRunSequence: 0,
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
    if (args.savedMessage)
      await recordRefs(ctx, (await ctx.db.get("assignments", childId))!, [args.savedMessage]);
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
      blocked: v.boolean(),
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
      subject: child.subject,
      childThreadId: run.childThreadId,
      childResultMessageId: run.childResultMessageId ?? null,
      blocked: await settlementBlocked(ctx, child),
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
    // Verification and the deferred outcome commit together, even while the
    // descendant fence holds. Claim clears this before any later turn starts.
    await ctx.db.patch("subagentRuns", run._id, {
      lastTurnResult: {
        ...(args.childResultMessageId ? { messageId: args.childResultMessageId } : {}),
        errorCode: args.errorCode,
      },
    });
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
  args: { runId: v.string(), errorCode: v.optional(runErrorCode) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (!run || run.status === "completed" || run.status === "failed") return null;
    await ctx.db.patch("subagentRuns", run._id, {
      lastTurnResult: { errorCode: args.errorCode ?? "EXECUTION_AMBIGUOUS" },
    });
    const first = await settleRunState(
      ctx,
      run,
      "failed",
      args.errorCode ?? "EXECUTION_AMBIGUOUS",
      undefined,
    );
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

/** Each terminal delivery spends one hop and appends ready work immediately. */
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
  const parent = await ctx.db.get("assignments", run.actorAssignmentId);
  const at = Date.now();
  const phase = {
    accepted: "result_accepted",
    failed: "delivery_failed",
    blocked: "delivery_blocked",
  } as const;
  if (args.deliveryStatus === "accepted") {
    if ((!args.parentMessageId && !run.side) || !root || !parent)
      throw new Error("INVALID_DELIVERY");
    if (
      root.cancelled ||
      parent.cancelled ||
      parent.turnStatus === "recovery_required" ||
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
    // Only releaseGroup orders a joined cohort by it; "each" rows never need it.
    ...(args.parentMessageId && run.join ? { resultSequence: parent?.nextSequence } : {}),
    events: appendEvent(run.events, phase[args.deliveryStatus], at, args.errorCode),
  });
  if (run.side) return null;
  const budget = await ctx.db.get("runs", run.parentRunId);
  if (budget)
    await ctx.db.patch("runs", budget._id, {
      hops: args.deliveryStatus === "accepted" ? budget.hops + 1 : budget.hops,
    });
  if (
    !parent ||
    !root ||
    root.cancelled ||
    parent.cancelled ||
    root.cancellationEpoch !== run.rootCancellationEpoch
  )
    return null;
  if (
    args.deliveryStatus === "accepted" &&
    (!budget || budget.cancelled || budget.hops >= root.limits.runHops)
  )
    throw new Error("RUN_BUDGET");
  if (run.join) {
    // <=15 members *4 KiB =60 KiB. Mark readiness and enqueue ONE id-only
    // anchor; <=15 release markers. No historical candidate prefix is read.
    // Native child bodies are verified ONE per delivery transaction (<=1 MiB);
    // this join reads ids only, never 15 potentially 1 MiB native results.
    const members = await ctx.db
      .query("subagentRuns")
      .withIndex("by_group", (q) =>
        q
          .eq("parentRunId", run.parentRunId)
          .eq("actorAssignmentId", parent._id)
          .eq("group", run.group ?? ""),
      )
      .take(root.limits.activeChildrenPerRoot);
    if (args.deliveryStatus === "accepted") {
      await ctx.db.patch("assignments", parent._id, { nextSequence: parent.nextSequence + 1 });
      parent.nextSequence++;
    }
    await markGroupReady(ctx, members, root);
    await wake(ctx, (await ctx.db.get("assignments", parent._id))!);
  } else if (args.deliveryStatus === "accepted" && args.parentMessageId) {
    if (parent.queuedMessages >= root.limits.queueLength) throw new Error("QUEUE_LIMIT");
    await ctx.db.insert("inbox", {
      assignmentId: parent._id,
      messageId: args.parentMessageId,
      sequence: parent.nextSequence,
      kind: "result",
      runId: run.parentRunId,
    });
    const backlogged = {
      ...parent,
      queuedMessages: parent.queuedMessages + 1,
      nextSequence: parent.nextSequence + 1,
    };
    await ctx.db.patch("assignments", parent._id, {
      queuedMessages: backlogged.queuedMessages,
      nextSequence: backlogged.nextSequence,
    });
    await wake(ctx, backlogged);
  } else await wake(ctx, parent);
  return null;
}

/** Readiness belongs to one sealed cohort, never a prefix of historical runs.
 * One representative is sufficient for indexed discovery; release marks every
 * member together. Membership is immutable after continueTurn/finish seals it.
 */
async function markGroupReady(
  ctx: MutationCtx,
  members: Doc<"subagentRuns">[],
  root: Doc<"assignments">,
) {
  if (
    !members.length ||
    members.some(
      (member) =>
        (member.join !== "sealed" && member.join !== "ready") ||
        member.deliveryStatus === "pending" ||
        !["completed", "failed"].includes(member.status) ||
        member.rootCancellationEpoch !== root.cancellationEpoch,
    )
  )
    return;
  // members come from one by_group range in creation order, so members[0] is
  // the same row on every call: at most one "ready" row per cohort.
  if (members[0].join === "sealed")
    await ctx.db.patch("subagentRuns", members[0]._id, { join: "ready" });
}

/** Release uses recorded parent-message ids only. Full inboxes defer this
 * control transition until wake observes a freed slot; native delivery is
 * already committed and is NEVER attempted again.
 */
async function releaseGroup(
  ctx: MutationCtx,
  parent: Doc<"assignments">,
  root: Doc<"assignments">,
  members: Doc<"subagentRuns">[],
) {
  if (
    !members.length ||
    members.some(
      (member) =>
        !member.join ||
        member.join === "open" ||
        member.deliveryStatus === "pending" ||
        !["completed", "failed"].includes(member.status) ||
        member.rootCancellationEpoch !== root.cancellationEpoch,
    )
  )
    return false;
  if (members.some((member) => member.join === "joined")) return false;
  const accepted = members
    .filter((member) => member.deliveryStatus === "accepted" && member.resultMessageId)
    .sort((a, b) => (a.resultSequence ?? 0) - (b.resultSequence ?? 0));
  if (accepted.length && parent.queuedMessages >= root.limits.queueLength) return false;
  // Mark all <=15 members "joined" so the by_join fence probes retire the
  // entire cohort, including failures. No delivered body is read or copied.
  for (const member of members) await ctx.db.patch("subagentRuns", member._id, { join: "joined" });
  if (!accepted.length) return true;
  await ctx.db.insert("inbox", {
    assignmentId: parent._id,
    messageId: accepted[accepted.length - 1].resultMessageId!,
    messageSequence: accepted[accepted.length - 1].resultSequence!,
    earliestMessageId: accepted[0].resultMessageId!,
    earliestMessageSequence: accepted[0].resultSequence!,
    sequence: parent.nextSequence,
    // A joined release carries delegated results. Labelling it "note" made
    // hooks.origins report the newest member's result as an origin-less note
    // while the release was queued; wake and claim treat "result" and "note"
    // identically, so only the label changes.
    kind: "result",
    runId: members[0].parentRunId,
  });
  await ctx.db.patch("assignments", parent._id, {
    queuedMessages: parent.queuedMessages + 1,
    nextSequence: parent.nextSequence + 1,
  });
  return true;
}

/** A fast child may settle between two tool calls in the same model slice.
 * Seal only at that slice's existing completion mutation, never at settlement.
 * There is only one running slice per assignment; all unsealed members of its
 * current run belong to it. <=50 launch rows *4 KiB plus <=50 patch reads
 * =400 KiB, <=100 reads/50 writes. The index excludes older request budgets
 * and already sealed cohorts; no transcript or Workflow journal is consulted.
 *
 * The range also pins the root's CURRENT epoch. That excludes nothing: an open
 * member from an older epoch can never share parent.runId with a running
 * parent. A cancel that bumps the epoch while a member of run R is still open
 * finds R either as root.runId (the root stays on R until a slice end seals R's
 * members: approval pauses and recovery_required both keep runId) or as the
 * runId of the member's still-active actor, and marks R cancelled; it also
 * idles that actor and deletes its ready inbox rows. Afterwards every path
 * that could enqueue ready work for R is fenced (reserve/continueAdmission by
 * R.cancelled; attach, delivery, post and release by the epoch), so no
 * assignment runs under R again and reserve refuses any new member of R.
 */
export async function sealGroups(ctx: MutationCtx, parent: Doc<"assignments">) {
  if (!parent.runId) return;
  const root = parent.rootAssignmentId
    ? await ctx.db.get("assignments", parent.rootAssignmentId)
    : parent;
  if (!root) return;
  const members = await ctx.db
    .query("subagentRuns")
    .withIndex("by_join", (q) =>
      q
        .eq("actorAssignmentId", parent._id)
        .eq("rootCancellationEpoch", root.cancellationEpoch)
        .eq("join", "open")
        .eq("parentRunId", parent.runId!),
    )
    .take(parent.limits.runLaunches);
  for (const member of members) {
    await ctx.db.patch("subagentRuns", member._id, { join: "sealed" });
    member.join = "sealed";
  }
  const groups = new Set(members.map((member) => member.group ?? ""));
  // Partition the <=50 just-sealed rows in memory; no repeated group queries.
  for (const group of groups)
    await markGroupReady(
      ctx,
      members.filter((member) => (member.group ?? "") === group),
      root,
    );
}

/** Ready-group recovery uses an exact indexed representative, then only that
 * cohort's <=15 members (<=64 KiB + fixed assignment metadata). Old incomplete
 * groups never enter this range. Release one cohort per wake; remaining ready
 * cohorts are serviced by the next claim/finish without a scheduled sweep.
 */
export const releaseGroups = mutation({
  args: { assignmentId: v.id("assignments"), parentRunId: v.optional(v.id("runs")) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const parent = await ctx.db.get("assignments", args.assignmentId);
    if (!parent || parent.cancelled || parent.queuedMessages >= parent.limits.queueLength)
      return false;
    const root = parent.rootAssignmentId
      ? await ctx.db.get("assignments", parent.rootAssignmentId)
      : parent;
    if (!root || root.cancelled) return false;
    const candidate = await ctx.db
      .query("subagentRuns")
      .withIndex("by_join", (q) => {
        const ready = q
          .eq("actorAssignmentId", parent._id)
          .eq("rootCancellationEpoch", root.cancellationEpoch)
          .eq("join", "ready");
        return args.parentRunId ? ready.eq("parentRunId", args.parentRunId) : ready;
      })
      .first();
    if (!candidate) return false;
    const members = await ctx.db
      .query("subagentRuns")
      .withIndex("by_group", (q) =>
        q
          .eq("parentRunId", candidate.parentRunId)
          .eq("actorAssignmentId", parent._id)
          .eq("group", candidate.group ?? ""),
      )
      .take(root.limits.activeChildrenPerRoot);
    const released = await releaseGroup(ctx, parent, root, members);
    if (released) await settleIdleParent(ctx, (await ctx.db.get("assignments", parent._id))!);
    return released;
  },
});

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
      page: page.map((run) => ({
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
      })),
      isDone: rows.length <= size,
      continueCursor: page.length ? String(page[page.length - 1].sequence) : "",
    };
  },
});

const interactionArgs = {
  assignmentId: v.id("assignments"),
  turnToken: v.string(),
  op: v.union(v.literal("message"), v.literal("ask")),
  runId: v.optional(v.string()),
};

/** Constant-size admission: actor + root + target + child + shared budget.
 * No native payload is read here. All writes below rerun this check inside
 * the native-save transaction, so neither a stale turn nor root cancellation
 * can admit a question/message after its fence.
 */
async function interaction(
  ctx: QueryCtx | MutationCtx,
  args: {
    assignmentId: Doc<"assignments">["_id"];
    turnToken: string;
    op: "message" | "ask";
    runId?: string;
  },
) {
  const denied = (
    code:
      | "STALE_TURN"
      | "FORBIDDEN"
      | "CHILD_FINISHED"
      | "MESSAGE_LIMIT"
      | "ASK_PENDING"
      | "ASK_WITH_CHILDREN"
      | "RUN_BUDGET"
      | "QUEUE_LIMIT",
  ) => ({ kind: "denied" as const, code });
  const actor = await ctx.db.get("assignments", args.assignmentId);
  if (
    !actor ||
    actor.cancelled ||
    actor.turnToken !== args.turnToken ||
    actor.turnStatus !== "running"
  )
    return denied("STALE_TURN");
  const root = actor.rootAssignmentId
    ? await ctx.db.get("assignments", actor.rootAssignmentId)
    : actor;
  if (!root || root.cancelled) return denied("FORBIDDEN");
  const run = await runById(ctx, args.op === "ask" ? (actor.childRunId ?? "") : (args.runId ?? ""));
  if (
    !run ||
    run.rootAssignmentId !== root._id ||
    (args.op === "ask" && run.parentRunId !== actor.runId) ||
    run.rootCancellationEpoch !== root.cancellationEpoch
  )
    return denied("FORBIDDEN");
  if (args.op === "ask" && run.status === "asking") return denied("ASK_PENDING");
  if (args.op === "ask" && (await hasPendingChildren(ctx, actor, true)))
    return denied("ASK_WITH_CHILDREN");
  if (run.status !== "running" && !(args.op === "message" && run.status === "asking"))
    return denied("CHILD_FINISHED");
  if (!run.childAssignmentId) return denied("FORBIDDEN");
  const child = await ctx.db.get("assignments", run.childAssignmentId);
  const parent = await ctx.db.get("assignments", run.actorAssignmentId);
  if (
    !child ||
    !parent ||
    child.cancelled ||
    parent.cancelled ||
    child.turnStatus === "recovery_required" ||
    parent.turnStatus === "recovery_required"
  )
    return denied("FORBIDDEN");
  if (args.op === "message" && child._id === actor._id) return denied("FORBIDDEN");
  if (args.op === "ask" && child._id !== actor._id) return denied("FORBIDDEN");
  if (args.op === "message" && run.messagesReceived >= root.limits.messagesPerChild)
    return denied("MESSAGE_LIMIT");
  const target = args.op === "message" ? child : parent;
  // One extra slot is reserved exclusively for the answer to an open question.
  // A new question cannot reserve another while that extra slot is occupied.
  const answering = args.op === "message" && run.status === "asking";
  if (
    (!answering && target.queuedMessages >= root.limits.queueLength) ||
    (args.op === "ask" && child.queuedMessages > root.limits.queueLength)
  )
    return denied("QUEUE_LIMIT");
  const budget = await ctx.db.get("runs", run.parentRunId);
  if (!budget || budget.cancelled || budget.hops >= root.limits.runHops)
    return denied("RUN_BUDGET");
  return { kind: "ready" as const, actor, root, run, child, parent, budget };
}

/** Trusted target projection for the host's atomic native message saves. */
export const interactionContext = query({
  args: interactionArgs,
  handler: async (ctx, args) => {
    const value = await interaction(ctx, args);
    if (value.kind === "denied") return value;
    const { run, root, parent, child, actor } = value;
    return {
      kind: "ready" as const,
      runId: run.runId,
      agent: run.agent,
      subject: root.subject,
      childThreadId: child.threadId,
      parentThreadId: parent.threadId,
      rootThreadId: root.threadId,
      rootAssignmentId: root._id,
      rootAgent: root.agent,
      actorAgent: actor.agent,
      parentAgent: parent.agent,
    };
  },
});

async function post(
  ctx: MutationCtx,
  target: Doc<"assignments">,
  runId: Doc<"runs">["_id"],
  messageId: string,
  kind: "parent" | "note",
  answering = false,
) {
  if (target.queuedMessages >= target.limits.queueLength + Number(answering))
    throw new Error("QUEUE_LIMIT");
  await ctx.db.insert("inbox", {
    assignmentId: target._id,
    runId,
    messageId,
    kind,
    sequence: target.nextSequence,
  });
  const next = {
    ...target,
    queuedMessages: target.queuedMessages + 1,
    nextSequence: target.nextSequence + 1,
  };
  await ctx.db.patch("assignments", target._id, {
    queuedMessages: next.queuedMessages,
    nextSequence: next.nextSequence,
  });
  await wake(ctx, next);
}

/** The exact native follow-up id is saved in the inbox in the same transaction. */
export const messageChild = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    runId: v.string(),
    messageId: v.string(),
  },
  handler: async (ctx, args) => {
    const value = await interaction(ctx, { ...args, op: "message" });
    if (value.kind === "denied") throw new Error(value.code);
    const { child, run, budget } = value;
    await ctx.db.patch("subagentRuns", run._id, {
      status: "running",
      questionMessageId: undefined,
      messagesReceived: run.messagesReceived + 1,
    });
    await ctx.db.patch("runs", budget._id, { hops: budget.hops + 1 });
    await post(ctx, child, budget._id, args.messageId, "parent", run.status === "asking");
    return { status: "accepted" as const, runId: run.runId };
  },
});

/** Asking holds the active slot. The question bypasses result joins (otherwise
 * a child waiting for its parent would deadlock its own group). Its native
 * assistant id and the parent's inbox id commit with BOTH native saves.
 */
export const askParent = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    questionMessageId: v.string(),
    parentMessageId: v.string(),
  },
  handler: async (ctx, args) => {
    const value = await interaction(ctx, { ...args, op: "ask" });
    if (value.kind === "denied") throw new Error(value.code);
    const { run, budget, parent } = value;
    await ctx.db.patch("subagentRuns", run._id, {
      status: "asking",
      questionMessageId: args.questionMessageId,
    });
    await ctx.db.patch("runs", budget._id, { hops: budget.hops + 1 });
    await post(ctx, parent, budget._id, args.parentMessageId, "note");
    return { status: "accepted" as const, runId: run.runId };
  },
});

/** Only a recorded open question can be authenticated; never scan history. */
export const questionContext = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    return run?.status === "asking" ? (run.questionMessageId ?? null) : null;
  },
});

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
export const runTree = query({
  args: { threadId: v.string(), subject: v.string() },
  handler: async (ctx, args) => {
    const root = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!root || root.subject !== args.subject || root.childRunId) throw new Error("FORBIDDEN");
    if (!root.runId) return [];
    const rows = await ctx.db
      .query("subagentRuns")
      .withIndex("by_group", (q) => q.eq("parentRunId", root.runId!))
      .take(root.limits.runLaunches + root.limits.sideRunsPerRun);
    rows.sort((a, b) => a.sequence - b.sequence);
    return rows.map((run) => ({
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
    }));
  },
});
