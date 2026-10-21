// Bounded, one-level asynchronous subagent runs.
//
// A root agent can call the managed `agevex_delegate` tool during a
// **user-triggered** turn. That tool awaits one short host mutation which, in a
// single Convex transaction, validates ownership and the permitted graph edge,
// creates the native child thread/task, writes one `subagentRuns` row and
// enqueues the child turn into the same Workpool. The root action never waits
// for the child to finish.
//
// Ownership split: this module stores references and state only. The child's
// prompt text, its output and the parent's result notification all live in the
// host's native Agent transcripts. Nothing here is a child transcript endpoint,
// a task result, a read receipt or an exactly-once guarantee about provider,
// model or tool side effects.
//
// Depth is 1 by construction: only a root assignment without `runId` may launch,
// so a child can never recurse and no cycle detection is needed at runtime.
// `registerAgent` rejects deeper graphs before any of this is reachable.
//
// Ownership validation happens before authorization on the host side
// (`subagents.delegateContext` / `settlementContext` / `deliveryContext`), and
// every mutation re-checks the same persisted invariants transactionally, so a
// forged, stale or cross-root capability is refused before any policy call or
// write.

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
import { pool, wake } from "./queue.js";
import { denialCode, runErrorCode, subagentRun, vPaginationResult } from "./schema.js";
import {
  MAX_ACTIVE_CHILD_RUNS,
  MAX_DELEGATIONS_PER_USER_PROMPT,
  MAX_DELEGATION_PAGE,
  MAX_RUN_EVENTS,
} from "./limits.js";

/** Decision returned by a reservation attempt; `replay` never creates work twice. */
const reservation = v.union(
  v.object({ kind: v.literal("reserved"), runId: v.string() }),
  v.object({ kind: v.literal("replay"), runId: v.string(), agent: v.string() }),
  v.object({ kind: v.literal("denied"), code: denialCode }),
);

/**
 * Everything a host needs to authorize and perform one delivery attempt.
 *
 * Contains no delivery token and no transcript content: the token must be
 * supplied by the caller and checked against the persisted one, and the actual
 * result text is read from the verified native child message.
 */
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
  /**
   * False when the root assignment is missing or `recovery_required`. A
   * `false` here is the truthful "delivery will be blocked" signal: no native
   * parent write may be attempted.
   */
  rootAvailable: v.boolean(),
} as const;

/** Point read of a run by its public id. */
async function runById(ctx: QueryCtx | MutationCtx, runId: string) {
  return ctx.db
    .query("subagentRuns")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

/** Append one bounded transition, keeping at most {@link MAX_RUN_EVENTS}. */
function appendEvent(
  events: Doc<"subagentRuns">["events"],
  phase: Doc<"subagentRuns">["events"][number]["phase"],
  at: number,
  errorCode: Doc<"subagentRuns">["errorCode"],
) {
  return [...events, { phase, at, errorCode }].slice(-MAX_RUN_EVENTS);
}

/**
 * Record the terminal outcome of a run exactly once and move the root counters.
 *
 * A run that already reached `completed`/`failed` is left untouched, so a late
 * success can never overwrite a watchdog or failure terminal state and the
 * counters cannot drift. Returns whether this call was the one that settled it.
 */
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

/**
 * Trusted ownership projection for a delegation attempt.
 *
 * Deliberately unauthenticated, like `queue.assignment`: it exposes only stored
 * identity fields and returns `null` unless the caller holds the exact
 * currently-RUNNING token of a **root** assignment whose turn originated from a
 * caller prompt. A child assignment or a result-triggered continuation resolves
 * to `null`, so the managed tool is never offered or accepted for them.
 *
 * The host compares the returned subject with its own authorization decision
 * before returning anything to the model.
 */
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
    if ((row.turnOrigin ?? "user") !== "user") return null;
    if (row.runId || row.rootAssignmentId) return null;
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
 * Reserve one child run before any native thread or message is created.
 *
 * Transactional checks, in order: the actor still owns this exact running token;
 * the actor is a root with a user-origin turn; the scoped dedup tuple
 * (actor assignment + turn token + native tool call id) has not been used; the
 * root's concurrent-child cap has not been reached; and this turn has not
 * already spent its per-prompt launch allowance.
 *
 * - An identical payload under the same tuple returns `replay` with the original
 *   run id, so a duplicated tool callback cannot start a second child, and a
 *   replay spends nothing: neither the concurrent cap nor the per-prompt count.
 * - The same tuple with a changed payload is `DELEGATION_CONFLICT`, not a replay.
 * - Exceeding the concurrent-child cap is `ACTIVE_LIMIT`.
 * - A further, differently identified launch from the same accepted user prompt
 *   is `TASK_LIMIT` once that turn's allowance of
 *   {@link MAX_DELEGATIONS_PER_USER_PROMPT} launches is spent, which is checked
 *   after the concurrent-child cap: while the root is below its concurrent cap
 *   the allowance answers `TASK_LIMIT` first, and `ACTIVE_LIMIT` is only
 *   reached once the cap is also full. The allowance is persisted on the root
 *   assignment as the `delegatedTurnToken`/`delegatedTurnCount` pair and is
 *   written in this same transaction, so it is rolled back with the run row if
 *   the native thread creation or `attach` fails, and it is never restored by a
 *   child that fails or completes.
 * - A lost race, stale token or non-root actor is `STALE_TURN` / `FORBIDDEN`.
 *
 * Denials are tool results, never root-generation failures: nothing here throws
 * for an expected refusal, and the reservation writes the `queued` transition,
 * the consumed allowance and the root's active counter in one transaction.
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
    if ((row.turnOrigin ?? "user") !== "user" || row.runId || row.rootAssignmentId)
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
    if ((row.activeRuns ?? 0) >= MAX_ACTIVE_CHILD_RUNS)
      return { kind: "denied" as const, code: "ACTIVE_LIMIT" as const };
    // The concurrent cap above is a per-root ceiling across prompts, not a
    // per-prompt bound: it does not drop when one child reaches a terminal state
    // while this turn may still be running. The persisted allowance is what
    // holds one accepted user prompt to a bounded fanout, so a fast-completed
    // child cannot reopen the launch. One accepted user prompt claims exactly
    // one turn, which makes the turn token the stable per-prompt anchor: the
    // token and its count are written together, so they can never disagree.
    //
    // A row written before `delegatedTurnCount` existed carries the matching
    // token with no count. That row has already spent one launch, so a missing
    // count reads as one rather than zero; a different or absent token means the
    // next accepted user prompt, which starts from zero.
    const spentTurns =
      row.delegatedTurnToken === args.turnToken ? (row.delegatedTurnCount ?? 1) : 0;
    if (spentTurns >= MAX_DELEGATIONS_PER_USER_PROMPT)
      return { kind: "denied" as const, code: "TASK_LIMIT" as const };
    const runId = crypto.randomUUID();
    const now = Date.now();
    const sequence = (row.nextRunSequence ?? 0) + 1;
    await ctx.db.insert("subagentRuns", {
      runId,
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
      // Consumed with the reservation, so a rolled-back launch leaves the
      // allowance unspent and a committed one cannot be reused. Only this
      // successful reservation writes the pair: `attach`, `claim`, `finish`,
      // settlement and delivery deliberately leave it alone, which is what
      // keeps a terminal child from replenishing its parent's prompt budget.
      delegatedTurnToken: args.turnToken,
      delegatedTurnCount: spentTurns + 1,
    });
    return { kind: "reserved" as const, runId };
  },
});

/**
 * Attach a freshly created native child thread to a reserved run.
 *
 * Runs in the same Convex transaction as the host's `createThread`/`saveMessage`
 * calls, so a failure anywhere rolls the whole launch back and no orphan thread,
 * run row or counter survives. Creates the child `assignments` row with its own
 * one-shot turn token and enqueues it through the shared Workpool; the child runs
 * the same bounded `runTurn` as a root turn.
 *
 * Idempotent by construction: a run that already has a child assignment is a no-op.
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
      turnStatus: "queued",
      errorCode: null,
      queuedMessages: 0,
      nextSequence: 0,
      nextTurn: 1,
      turnOrigin: "user",
      rootAssignmentId: run.rootAssignmentId,
      runId: run.runId,
      activeRuns: 0,
      historyRuns: 0,
    });
    const turnToken = `${childId}:0`;
    await ctx.db.patch("assignments", childId, {
      turnToken,
      promptMessageId: args.promptMessageId,
    });
    await ctx.db.patch("subagentRuns", run._id, {
      childAssignmentId: childId,
      childThreadId: args.childThreadId,
    });
    await pool.enqueueAction(
      ctx,
      internal.worker.dispatch,
      { assignmentId: childId, turnToken, runTurn: run.runTurn },
      { retry: false },
    );
    return null;
  },
});

/**
 * Narrow a stored coordinator handle back to the one `notify` contract it has.
 *
 * Convex does not type an opaque `createFunctionHandle` string as a reference,
 * so the handle stored on a run is asserted to the shape it already has at
 * runtime. It is still not trusted: the coordinator re-checks the persisted
 * delivery capability and the terminal state before it writes anything.
 */
function notifyReference(handle: string) {
  return handle as unknown as FunctionReference<
    "mutation",
    "internal",
    { op: "notify"; runId: string; deliveryToken: string },
    null
  >;
}

/**
 * Delivery context proven by the child's own running turn token.
 *
 * Used by the host runner immediately after a child generation: the caller must
 * still hold the exact running token of the child assignment that owns the run,
 * and the run must still be non-terminal. It returns only what is needed to
 * *authenticate* the child's final message natively — thread, expected agent and
 * stored subject — plus the result message id the caller reported, which is
 * verified against that thread before any terminal state is written.
 *
 * `null` means the capability did not match or the run is not in the state a
 * settlement may act on; in either case the caller must write nothing.
 */
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
    if (!child || child.runId !== args.runId || child.turnToken !== args.turnToken) return null;
    if (child.turnStatus !== "running") return null;
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

/**
 * Delivery context proven by the run's persisted one-shot capability.
 *
 * The watchdog and handle-failure paths reach delivery without holding the child
 * turn token, so they present the stored `deliveryToken` instead. `null` means the
 * capability did not match, the run is not terminal, or a delivery attempt was
 * already recorded: in every case the caller must write nothing.
 */
export const deliveryContext = query({
  args: { runId: v.string(), deliveryToken: v.string() },
  returns: v.union(v.null(), v.object(deliveryContextFields)),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (!run || run.deliveryToken !== args.deliveryToken) return null;
    return terminalContext(ctx, run);
  },
});

/**
 * Terminal-state projection shared by both delivery-context queries.
 *
 * Returns `null` unless the run already reached `completed`/`failed` and still
 * has an unrecorded delivery attempt, and reports whether the root assignment
 * can accept a notification right now.
 */
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
    rootAvailable: root.turnStatus !== "recovery_required",
  };
}

/**
 * Record the child's reported outcome. Does not touch the parent transcript.
 *
 * Ownership is derived from persisted state: the caller must hold the exact
 * running token of the child assignment that owns this run, and that assignment
 * must be the one the run recorded at launch. The message id (if any) was
 * authenticated natively by the host against the child transcript before this
 * was called, so a caller-selected id cannot reach a `completed` state.
 * Settling is idempotent, so a duplicated report cannot double-count the run,
 * and a run already made terminal by the watchdog keeps that outcome.
 *
 * Deliberately its own transaction, separate from the delivery attempt, so a
 * failed delivery leaves the truthful child outcome and the exact counters
 * intact.
 */
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
    if (!child || child.runId !== args.runId || child.turnToken !== args.turnToken)
      throw new Error("FORBIDDEN");
    // A released or escalated turn cannot report an outcome any more.
    if (child.turnStatus !== "running") throw new Error("FORBIDDEN");
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

/**
 * Fail a run whose turn never reported: watchdog expiry or host handle failure.
 *
 * Records the terminal failed outcome, moves the root counters and schedules
 * exactly **one** bounded notification attempt through
 * {@link notify}. It never generates, replays or takes over the child, and it
 * never changes the root's own turn state — a healthy root stays usable.
 */
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

/**
 * Make the watchdog's single bounded delivery attempt for a terminal run.
 *
 * `escalate` can only *schedule*, and a scheduled host mutation that throws
 * records nothing at all, which would leave a terminal run `pending` forever and
 * keep an undelivered result capability alive. This component-internal action is
 * the action-side equivalent of the host runner's own attempt: it calls the
 * stored coordinator handle exactly once and, when that transaction did not
 * commit, records `failed` through a separate metadata-only transition that
 * uses the same one-shot capability and the same pending-status
 * compare-and-set.
 *
 * It never retries a delivery, never regenerates anything, and never changes the
 * run's terminal outcome. If even the failure record cannot commit, the run
 * stays honestly `pending` rather than claiming a delivery that was not stored.
 */
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

/**
 * Record the single bounded delivery attempt of a terminal run.
 *
 * One-shot: a run whose `deliveryStatus` is no longer `pending` is a no-op, so a
 * late success cannot overwrite a blocked/failed delivery and a duplicated
 * callback cannot deliver twice. The caller must already hold the persisted
 * capability (either the child turn token or the stored `deliveryToken`); this
 * mutation re-checks the token itself so it is not a trusted boolean.
 *
 * `accepted` additionally enqueues the already-saved native parent notification
 * into the root's FIFO backlog and wakes the root when it is idle, in the same
 * transaction. That is exactly "the transcript and the queue committed the
 * result" — not a read receipt, not semantic acknowledgement and not a completed
 * task.
 */
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

/**
 * Record that the single bounded delivery attempt of a terminal run did not
 * commit.
 *
 * Component-internal companion to {@link notify}: a mutation cannot observe a
 * failed nested call and keep writing, so the watchdog's attempt needs an
 * action to run in and this mutation to fall back on. It is the same one-shot
 * capability and the same pending-status compare-and-set as {@link deliver},
 * with the outcome fixed to `failed`; it never enqueues a parent notification,
 * so no native write can be committed without queue acceptance.
 */
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

/** Shared body of {@link deliver} and {@link failDelivery}. */
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
    if (root.turnStatus === "recovery_required") throw new Error("ROOT_UNAVAILABLE");
  }
  await ctx.db.patch("subagentRuns", run._id, {
    deliveryStatus: args.deliveryStatus,
    deliveryAt: at,
    errorCode: args.errorCode ?? run.errorCode,
    ...(args.parentMessageId ? { resultMessageId: args.parentMessageId } : {}),
    events: appendEvent(run.events, phase[args.deliveryStatus], at, args.errorCode),
  });
  if (args.deliveryStatus !== "accepted" || !args.parentMessageId || !root) return null;
  const backlogged = {
    ...root,
    queuedMessages: root.queuedMessages + 1,
    nextSequence: root.nextSequence + 1,
  };
  await ctx.db.insert("pending", {
    assignmentId: root._id,
    messageId: args.parentMessageId,
    sequence: root.nextSequence,
    origin: "subagent_result",
  });
  await ctx.db.patch("assignments", root._id, {
    queuedMessages: backlogged.queuedMessages,
    nextSequence: backlogged.nextSequence,
  });
  await wake(ctx, backlogged);
  return null;
}

/**
 * Cursor into the newest-first run history of one root.
 *
 * Opaque to clients: it is the root-scoped monotonic run sequence, which is a
 * total order over the root's runs, so a page is one bounded index range with no
 * filtering.
 */
function decodeCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  const sequence = Number(cursor);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("INVALID_CURSOR");
  return sequence;
}

/**
 * Newest-first page of one root's child runs.
 *
 * Ownership is checked explicitly here: the caller-supplied `subject` must match
 * the assignment's owner, otherwise `FORBIDDEN`. The host endpoint authorizes
 * before calling in, so this is defense in depth, not the only check.
 *
 * The page is a single bounded index range: `.paginate()` is unavailable inside a
 * Convex component, so the cursor is the root-scoped run sequence and the range
 * stops at it. Nothing collects the collection, and the size is clamped to
 * {@link MAX_DELEGATION_PAGE}. Rows are never deleted, so this is the full
 * retained history of the root's delegations, not a window.
 */
export const delegations = query({
  args: { threadId: v.string(), subject: v.string(), paginationOpts: paginationOptsValidator },
  returns: vPaginationResult(subagentRun),
  handler: async (ctx, args) => {
    const root = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!root || root.subject !== args.subject) throw new Error("FORBIDDEN");
    const size = Math.min(Math.max(1, args.paginationOpts.numItems), MAX_DELEGATION_PAGE);
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
