// Managed turn queue for the component.
//
// The component owns only assignment state, the accepted-message backlog and
// dispatch. Each turn must claim a one-shot token before the host generates, so a
// duplicate dispatch, a late finalization or an expired execution window can never
// produce a second generation. Generation, transcript and message bodies stay
// native: rows hold native ids only.
//
// Busy queue: at most one turn per assignment is dispatched. Additional accepted
// messages wait in `pending` and are woken by the finish path, where selection
// and enqueue share one transaction, so the queue state transition and the
// dispatch enqueue commit or fail together.
//
// No takeover: `recovery_required` is terminal for this component. Nothing here
// expires a token, replays a generation or repairs state, and there is no
// retention/expiry policy, so rows live until the host deletes them.

import { Workpool } from "@convex-dev/workpool";
import { v } from "convex/values";
import { internal, components } from "./_generated/api.js";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  activity as vActivity,
  receipt as vReceipt,
  scope,
  errorCode,
  turnOrigin as vTurnOrigin,
} from "./schema.js";
import { EXECUTION_WATCHDOG_MS, MAX_PARALLEL_TURNS } from "./limits.js";

const pool = new Workpool(components.workpool, {
  maxParallelism: MAX_PARALLEL_TURNS,
  retryActionsByDefault: false,
});

/**
 * Shared Workpool used by every managed root and child turn.
 *
 * Exported for the subagent launch path, which enqueues the child through the
 * same pool rather than a second concurrency lane. Enqueue *names* are labels.
 */
export { pool };
// The execution window belongs to a turn that owns the assignment, not to one
// that is still waiting for Workpool capacity. It is therefore armed by `claim`,
// never by `wake`, so a backlog larger than the pool cannot expire queued work.

/**
 * Resolve a previously accepted request, or report conflicting reuse of its key.
 *
 * Read-only: it writes nothing and enqueues nothing. An exact fingerprint match
 * replays the original acceptance receipt (`status: "accepted"` — not a result); a
 * different fingerprint under the same `subject + requestKey` throws
 * `REQUEST_KEY_CONFLICT` so the host fails the retry before any native write.
 */
async function existing(
  ctx: Pick<QueryCtx, "db">,
  subject: string,
  requestKey: string,
  fingerprint: string,
) {
  const row = await ctx.db
    .query("receipts")
    .withIndex("by_subject_key", (q) => q.eq("subject", subject).eq("requestKey", requestKey))
    .unique();
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new Error("REQUEST_KEY_CONFLICT");
  return {
    assignmentId: row.assignmentId,
    threadId: row.threadId,
    receiptId: row._id,
    status: "accepted" as const,
  };
}

/**
 * Public read of an accepted request that creates nothing. Same replay/conflict
 * semantics as `accept`; `null` means the key was never accepted.
 */
export const lookupReceipt = query({
  args: { subject: v.string(), requestKey: v.string(), fingerprint: v.string() },
  returns: v.union(v.null(), vReceipt),
  handler: (ctx, args) => existing(ctx, args.subject, args.requestKey, args.fingerprint),
});

/**
 * Ownership projection of an existing assignment, or `null` for an unknown thread.
 *
 * Deliberately unauthenticated: it exposes only stored identity and role fields.
 * The host endpoint compares the returned `subject` with its own authorization
 * decision before returning anything to a caller.
 */
export const assignment = query({
  args: { threadId: v.string() },
  returns: v.union(v.null(), v.object({ ...scope.fields, root: v.boolean() })),
  handler: async (ctx, { threadId }) => {
    const row = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .unique();
    // The assignment's role is fixed by how it was created: a delegated child
    // carries its runId, while a public root does not. Never infer this from
    // the current registration's root names. A host could later promote a
    // former child agent name to a root; that must not promote its old child
    // threads or permit public sends outside the coordinator's lifecycle.
    // Keep this extra projection local to assignment so claim's execution
    // scope and its root/child turn payload remain unchanged.
    return row
      ? {
          assignmentId: row._id,
          threadId,
          subject: row.subject,
          agent: row.agent,
          root: row.runId === undefined,
        }
      : null;
  },
});

/**
 * Dispatch the head of an idle assignment's backlog.
 *
 * Guarded to be a no-op unless the assignment is `idle`, which is what makes it
 * safe to call from both `accept` and `finish`. In one transaction it deletes the
 * selected backlog row, publishes a fresh turn token plus that row's
 * `promptMessageId`, and enqueues dispatch. Deleting first means one backlog row
 * is consumed for exactly one turn; doing the state change and the enqueue in one
 * transaction means they commit or fail together. Neither is an exactly-once
 * guarantee about provider, model or tool side effects, nor a liveness guarantee
 * about downstream scheduling.
 */
export async function wake(ctx: MutationCtx, row: Doc<"assignments">) {
  if (row.turnStatus !== "idle") return;
  const next = await ctx.db
    .query("pending")
    .withIndex("by_assignment_sequence", (q) => q.eq("assignmentId", row._id))
    .first();
  if (!next) return;
  const turnToken = `${row._id}:${row.nextTurn}`;
  await ctx.db.delete("pending", next._id);
  await ctx.db.patch("assignments", row._id, {
    turnStatus: "queued",
    turnToken,
    promptMessageId: next.messageId,
    turnOrigin: next.origin ?? "user",
    nextTurn: row.nextTurn + 1,
    queuedMessages: row.queuedMessages - 1,
  });
  await pool.enqueueAction(
    ctx,
    internal.worker.dispatch,
    { assignmentId: row._id, turnToken, runTurn: row.runTurn },
    { retry: false },
  );
}

/**
 * Accept one message into an assignment and return an acceptance receipt.
 *
 * Side effects, in order: create the assignment on a thread's first accept;
 * append a `pending` backlog row and bump `queuedMessages`/`nextSequence`; write
 * the immutable `receipts` dedup row; then wake a turn when the assignment is
 * idle. The native thread and message are saved by the host endpoint, which passes
 * `promptMessageId` — the component persists only that native reference.
 *
 * Idempotency: an exact `(subject, requestKey, fingerprint)` replay returns the
 * original receipt without re-enqueueing; a changed fingerprint for the same key
 * throws `REQUEST_KEY_CONFLICT`.
 *
 * Ownership boundary: `subject` and `agent` are the host's trusted policy values.
 * An existing assignment owned by a different subject or agent throws `FORBIDDEN`;
 * the component enforces ownership by identity comparison, not by access rules.
 *
 * Returns: a receipt meaning "durably queued". It is not generated output, not a
 * read, not a finished turn and not task completion, and the turn may still be
 * waiting behind the pool.
 */
export const accept = mutation({
  args: {
    subject: v.string(),
    agent: v.string(),
    threadId: v.string(),
    requestKey: v.string(),
    fingerprint: v.string(),
    promptMessageId: v.string(),
    runTurn: v.string(),
  },
  returns: vReceipt,
  handler: async (ctx, args) => {
    const duplicate = await existing(ctx, args.subject, args.requestKey, args.fingerprint);
    if (duplicate) return duplicate;
    let row = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!row) {
      const id = await ctx.db.insert("assignments", {
        subject: args.subject,
        agent: args.agent,
        threadId: args.threadId,
        runTurn: args.runTurn,
        turnStatus: "idle",
        errorCode: null,
        queuedMessages: 0,
        nextSequence: 0,
        nextTurn: 0,
      });
      row = (await ctx.db.get("assignments", id))!;
    }
    if (row.subject !== args.subject || row.agent !== args.agent) throw new Error("FORBIDDEN");
    if (row.turnStatus === "recovery_required") throw new Error("RECOVERY_REQUIRED");
    await ctx.db.insert("pending", {
      assignmentId: row._id,
      messageId: args.promptMessageId,
      sequence: row.nextSequence,
      origin: "user",
    });
    await ctx.db.patch("assignments", row._id, {
      queuedMessages: row.queuedMessages + 1,
      nextSequence: row.nextSequence + 1,
    });
    const receiptId = await ctx.db.insert("receipts", {
      subject: args.subject,
      requestKey: args.requestKey,
      fingerprint: args.fingerprint,
      assignmentId: row._id,
      threadId: args.threadId,
    });
    await wake(ctx, { ...row, queuedMessages: row.queuedMessages + 1 });
    return {
      assignmentId: row._id,
      threadId: args.threadId,
      receiptId,
      status: "accepted" as const,
    };
  },
});

/**
 * Take ownership of one turn and return the prompt anchor to generate from.
 *
 * Returns `null` unless the assignment exists, still holds this exact
 * `turnToken` and is `queued`, so duplicate dispatch, stale tokens and replays are
 * no-ops rather than takeovers. The token is one-shot: a successful `finish`
 * clears it, so the same token can never claim twice.
 *
 * Also arms the execution watchdog here, in the same transaction that marks the
 * turn `running`, so a turn receives its full window from the moment execution
 * starts no matter how long it waited for pool capacity.
 *
 * A child turn additionally returns the trusted `subagent` context (run id,
 * delivery capability, root linkage) and records the run's `started` transition
 * in this same transaction. That context is derived from persisted state, never
 * from anything the caller supplied, and it is what lets the host runner report
 * and later deliver the run's single bounded notification.
 */
export const claim = mutation({
  args: { assignmentId: v.id("assignments"), turnToken: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ...scope.fields,
      promptMessageId: v.string(),
      turnOrigin: vTurnOrigin,
      subagent: v.union(
        v.null(),
        v.object({
          runId: v.string(),
          agent: v.string(),
          rootAgent: v.string(),
          actorAgent: v.string(),
          subject: v.string(),
          rootAssignmentId: v.string(),
          rootThreadId: v.string(),
          childThreadId: v.string(),
          deliveryToken: v.string(),
        }),
      ),
    }),
  ),
  handler: async (ctx, { assignmentId, turnToken }) => {
    const row = await ctx.db.get("assignments", assignmentId);
    if (!row || row.turnToken !== turnToken || row.turnStatus !== "queued") return null;
    await ctx.db.patch("assignments", assignmentId, { turnStatus: "running" });
    // Scheduled exactly once, in the same transaction that takes ownership:
    // queued work waiting on the Workpool never burns this window.
    await ctx.scheduler.runAfter(EXECUTION_WATCHDOG_MS, internal.queue.stalled, {
      assignmentId,
      turnToken,
    });
    const runId = row.runId;
    if (!runId) {
      return {
        assignmentId,
        threadId: row.threadId,
        subject: row.subject,
        agent: row.agent,
        promptMessageId: row.promptMessageId!,
        turnOrigin: row.turnOrigin ?? "user",
        subagent: null,
      };
    }
    const run = await ctx.db
      .query("subagentRuns")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();
    const root = row.rootAssignmentId
      ? await ctx.db.get("assignments", row.rootAssignmentId)
      : null;
    if (!run || !root || run.status !== "queued") {
      // A launch without a resolvable run is a corrupt state; escalate rather
      // than generate against an untrackable child.
      await ctx.db.patch("assignments", assignmentId, {
        turnStatus: "recovery_required",
        errorCode: "EXECUTION_AMBIGUOUS",
      });
      return null;
    }
    await ctx.db.patch("subagentRuns", run._id, {
      status: "running",
      startedAt: Date.now(),
      events: [...run.events, { phase: "started" as const, at: Date.now(), errorCode: null }],
    });
    return {
      assignmentId,
      threadId: row.threadId,
      subject: row.subject,
      agent: row.agent,
      promptMessageId: row.promptMessageId!,
      turnOrigin: row.turnOrigin ?? "user",
      subagent: {
        runId: run.runId,
        agent: run.agent,
        rootAgent: run.rootAgent,
        actorAgent: run.actorAgent,
        subject: run.subject,
        rootAssignmentId: root._id,
        rootThreadId: root.threadId,
        childThreadId: row.threadId,
        deliveryToken: run.deliveryToken,
      },
    };
  },
});

/**
 * Report the outcome of the turn the caller owns.
 *
 * A no-op returning `null` unless the assignment is `running` under this exact
 * `turnToken`, which makes duplicate or late finalization harmless. A host-action
 * or finalization failure that propagates out of the runner reaches the
 * dispatcher, which calls `queue.ambiguous` promptly and escalates the turn to
 * `recovery_required`; if instead a claimed turn is abandoned with no propagated
 * failure and no successful finalization, the watchdog armed by `claim`
 * escalates it later. The component never infers an outcome from a failure it
 * never observes.
 *
 * On failure the turn becomes sticky `recovery_required` carrying the sanitized
 * code, and further messages are rejected. On success the turn returns to `idle`,
 * its token and prompt anchor are cleared, and any backlog is woken in the same
 * transaction, so an idle assignment cannot lose an accepted wakeup.
 */
export const finish = mutation({
  args: { assignmentId: v.id("assignments"), turnToken: v.string(), errorCode },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.turnToken !== args.turnToken || row.turnStatus !== "running") return null;
    if (args.errorCode) {
      await ctx.db.patch("assignments", row._id, {
        turnStatus: "recovery_required",
        errorCode: args.errorCode,
      });
    } else {
      await ctx.db.patch("assignments", row._id, {
        turnStatus: "idle",
        turnToken: undefined,
        promptMessageId: undefined,
      });
      await wake(ctx, { ...row, turnStatus: "idle" });
    }
    return null;
  },
});

/**
 * Escalate a child turn's run exactly once, if that assignment is a child.
 *
 * Called from the ambiguity and watchdog paths of `queue`. It never generates,
 * replays or takes over anything: it records the terminal failed outcome, moves
 * the root counters, and schedules exactly one bounded notification attempt
 * through the stored coordinator handle. Non-child assignments are a no-op, so
 * a root failure never touches subagent state.
 */
async function escalateChild(ctx: MutationCtx, assignmentId: Id<"assignments">) {
  const row = await ctx.db.get("assignments", assignmentId);
  if (!row?.runId) return null;
  await ctx.runMutation(internal.subagents.escalate, { runId: row.runId });
  return null;
}

/**
 * Mark the identified turn ambiguous while it is still `queued` or `running`.
 *
 * An escalation that loses the race to a successful `finish` is discarded, and no
 * generation is ever replayed.
 */
async function markAmbiguous(ctx: MutationCtx, assignmentId: Id<"assignments">, turnToken: string) {
  const row = await ctx.db.get("assignments", assignmentId);
  if (
    row &&
    row.turnToken === turnToken &&
    (row.turnStatus === "queued" || row.turnStatus === "running")
  ) {
    await ctx.db.patch("assignments", row._id, {
      turnStatus: "recovery_required",
      errorCode: "EXECUTION_AMBIGUOUS",
    });
    await escalateChild(ctx, row._id);
  }
  return null;
}

/**
 * Flag a turn as ambiguous after the host action reference failed to run.
 *
 * Separates a callback/handle failure from an execution stall: the action may
 * never have reached `claim`, so a still-`queued` turn is escalated too.
 * Sanitizing happens upstream — only `EXECUTION_AMBIGUOUS` is stored, never the
 * underlying exception.
 */
export const ambiguous = mutation({
  args: { assignmentId: v.id("assignments"), turnToken: v.string() },
  returns: v.null(),
  handler: (ctx, args) => markAmbiguous(ctx, args.assignmentId, args.turnToken),
});

/**
 * Detection-only watchdog for a turn that never finalized.
 *
 * Internal, fired by the timer armed in `claim`. It escalates a still-owned running
 * token to `recovery_required` and stops there: the window is never extended, the
 * owner is never replaced and no generation is replayed. A turn still waiting in
 * the pool is ignored, which is why the timer is armed on claim rather than wake.
 * A child turn additionally records its run as failed and schedules its single
 * bounded notification, so a healthy root is not blocked by a stalled child.
 */
export const stalled = internalMutation({
  args: { assignmentId: v.id("assignments"), turnToken: v.string() },
  returns: v.null(),
  // Detection only: never reassign an expired token or replay a generation.
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (row && row.turnToken === args.turnToken && row.turnStatus === "running") {
      await ctx.db.patch("assignments", row._id, {
        turnStatus: "recovery_required",
        errorCode: "EXECUTION_AMBIGUOUS",
      });
      await escalateChild(ctx, row._id);
    }
    return null;
  },
});

/**
 * Coordination view for one thread: turn progress, backlog size and sanitized
 * failure code. Additive to the native transcript read — not a completion status
 * and not a replacement message protocol.
 *
 * Ownership is checked here explicitly: the caller-supplied `subject` must match
 * the assignment's owner, otherwise `FORBIDDEN`. The host endpoint authorizes
 * before calling in.
 */
export const activity = query({
  args: { threadId: v.string(), subject: v.string() },
  returns: vActivity,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!row || row.subject !== args.subject) throw new Error("FORBIDDEN");
    return {
      assignmentId: row._id,
      threadId: row.threadId,
      agent: row.agent,
      assignmentStatus: "open" as const,
      turnStatus: row.turnStatus,
      queuedMessages: row.queuedMessages,
      errorCode: row.errorCode,
      subagents: {
        active: row.activeRuns ?? 0,
        history: row.historyRuns ?? 0,
        total: (row.activeRuns ?? 0) + (row.historyRuns ?? 0),
      },
    };
  },
});
