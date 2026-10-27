/**
 * Parent/child conversation while a delegation runs: follow-up messages from
 * a parent to its running (or asking) child (`messageChild`), and a child's
 * question to its parent (`askParent`, authenticated by `questionContext`).
 * Non-blocking progress uses the same admission and post helpers from parent_notes.ts.
 *
 * `interaction` is the bounded admission check shared by the trusted
 * context queries (`interactionContext`, `interactionTarget`, parentNoteContext) and writes
 * (`sendToChild`, `askParentRun`), which rerun it inside the host's
 * native-save transaction. `post` then enqueues the saved native message on
 * the target thread and wakes it. Touches `inbox`, the target's counters,
 * and (at the call sites) `subagentRuns` and `runs`.
 */
import { v } from "convex/values";
import { type MutationCtx, type QueryCtx, mutation, query } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { runById } from "./runs.js";
import { wake } from "../turns/wake.js";
import { hasPendingChildren } from "./settle.js";
import { denialCode } from "../schema.js";
import { LIMITS } from "../limits.js";
import { reserveFor } from "./headroom.js";

export const interactionArgs = {
  assignmentId: v.id("assignments"),
  turnToken: v.string(),
  op: v.union(v.literal("message"), v.literal("ask"), v.literal("message_parent")),
  runId: v.optional(v.string()),
};

type InteractionArgs = {
  assignmentId: Doc<"assignments">["_id"];
  turnToken: string;
  op: "message" | "ask" | "message_parent";
  runId?: string;
};

const denied = (
  code:
    | "STALE_TURN"
    | "FORBIDDEN"
    | "CHILD_FINISHED"
    | "MESSAGE_LIMIT"
    | "ASK_PENDING"
    | "ASK_WITH_CHILDREN"
    | "RUN_BUDGET"
    | "QUEUE_LIMIT"
    | "NO_PARENT"
    | "MESSAGE_RATE_LIMIT",
) => ({ kind: "denied" as const, code });

/** Bounded admission: actor + root + target + child + shared budget.
 * No native payload is read here. All writes below rerun this check inside
 * the native-save transaction, so neither a stale turn nor root cancellation
 * can admit a question/message after its fence.
 * `replay` skips only fresh-note capacity/rate/hop checks; live turn, epoch,
 * delegation, parent and budget cancellation fences must still hold.
 */
export async function interaction(
  ctx: QueryCtx | MutationCtx,
  args: InteractionArgs,
  replay = false,
) {
  const scope = await interactionRun(ctx, args);

  if (scope.kind === "denied") return scope;

  const { actor, root, run } = scope;

  const child = await ctx.db.get("assignments", run.childAssignmentId!);
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

  if (args.op === "message" && parent._id !== actor._id) return denied("FORBIDDEN");

  if (args.op !== "message" && child._id !== actor._id) return denied("FORBIDDEN");

  if (args.op === "message" && run.messagesReceived >= root.limits.messagesPerChild)
    return denied("MESSAGE_LIMIT");

  if (args.op === "message_parent") {
    // An old delegation cannot wake a terminal parent or attach work to a newer request.
    if (parent.runId !== run.parentRunId) return denied("FORBIDDEN");

    if (!replay && run.parentNotesSent >= root.limits.parentNotesPerChild)
      return denied("MESSAGE_LIMIT");

    if (
      !replay &&
      run.lastParentNoteAt !== undefined &&
      Date.now() - run.lastParentNoteAt < LIMITS.parentNoteIntervalMs
    )
      return denied("MESSAGE_RATE_LIMIT");
  }

  const target = args.op === "message" ? child : parent;
  // One extra slot is reserved exclusively for the answer to an open question.
  // A new question cannot reserve another while that extra slot is occupied.
  const answering = args.op === "message" && run.status === "asking";

  if (
    (!replay && !answering && target.queuedMessages >= root.limits.queueLength) ||
    (args.op === "ask" && child.queuedMessages > root.limits.queueLength)
  )
    return denied("QUEUE_LIMIT");

  const budget = await ctx.db.get("runs", run.parentRunId);

  if (!budget || budget.cancelled) return denied("RUN_BUDGET");

  if (!replay) {
    const kind = args.op === "message_parent" ? "note" : answering ? "answer" : args.op;
    const refusal = await reserveFor(ctx, kind, root, budget);

    if (refusal) return refusal;
  }

  return { kind: "ready" as const, actor, root, run, child, parent, budget };
}

/** The calling turn, its root and the delegation being addressed: for "ask"
 * the caller's own run, for "message" the named child run. Refuses stale
 * turns, foreign or cancelled-epoch runs, a second open question, a question
 * while the asker has live children, and finished children. */
async function interactionRun(ctx: QueryCtx | MutationCtx, args: InteractionArgs) {
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

  if (args.op === "message_parent" && !actor.childRunId) return denied("NO_PARENT");

  const run = await runById(
    ctx,
    args.op !== "message" ? (actor.childRunId ?? "") : (args.runId ?? ""),
  );

  if (
    !run ||
    run.rootAssignmentId !== root._id ||
    (args.op !== "message" && run.parentRunId !== actor.runId) ||
    run.rootCancellationEpoch !== root.cancellationEpoch
  )
    return denied("FORBIDDEN");

  if (args.op === "ask" && run.status === "asking") return denied("ASK_PENDING");

  if (args.op === "ask" && (await hasPendingChildren(ctx, actor)))
    return denied("ASK_WITH_CHILDREN");

  if (run.status !== "running" && !(args.op === "message" && run.status === "asking"))
    return denied("CHILD_FINISHED");

  if (!run.childAssignmentId) return denied("FORBIDDEN");

  return { kind: "run" as const, actor, root, run };
}

/** Enqueue an already saved native message as ready work on `target` and wake
 * it. `answering` lets a parent's reply to an open question use the one extra
 * reserved slot even when the child's ready queue is full. */
export async function post(
  ctx: MutationCtx,
  target: Doc<"assignments">,
  runId: Doc<"runs">["_id"],
  messageId: string,
  kind: "parent" | "note",
  answering = false,
  from?: string,
) {
  if (!answering && target.queuedMessages >= target.limits.queueLength)
    throw new Error("QUEUE_LIMIT");

  await ctx.db.insert("inbox", {
    assignmentId: target._id,
    runId,
    messageId,
    kind,
    from,
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

/** Trusted target projection for the host's atomic native message saves:
 * the threads and agents on both ends, or the admission denial. */
export async function interactionTarget(ctx: QueryCtx, args: InteractionArgs) {
  const value = await interaction(ctx, args);

  if (value.kind === "denied") return value;

  const { run, root, parent, child, actor } = value;

  return {
    kind: "ready" as const,
    runId: run._id,
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
}

/** Shared trusted projection validator, including admission denials before native saves. */
export const interactionResult = v.union(
  v.object({ kind: v.literal("denied"), code: denialCode }),
  v.object({
    kind: v.literal("ready"),
    runId: v.string(),
    agent: v.string(),
    subject: v.string(),
    childThreadId: v.string(),
    parentThreadId: v.string(),
    rootThreadId: v.string(),
    rootAssignmentId: v.id("assignments"),
    rootAgent: v.string(),
    actorAgent: v.string(),
    parentAgent: v.string(),
  }),
);

/** `subagents.messages.messageChild`: the exact native follow-up id is saved in the
 * child's inbox in the same transaction. Answers an open question (resuming
 * the child) when the child is asking; spends one hop either way. */
async function sendToChild(
  ctx: MutationCtx,
  args: {
    assignmentId: Doc<"assignments">["_id"];
    turnToken: string;
    runId: string;
    messageId: string;
  },
) {
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

  return { status: "accepted" as const, runId: run._id };
}

/** `subagents.messages.askParent`: asking holds the active slot. Its native assistant id and the parent's inbox id commit with
 * BOTH native saves; spends one hop. */
async function askParentRun(
  ctx: MutationCtx,
  args: {
    assignmentId: Doc<"assignments">["_id"];
    turnToken: string;
    questionMessageId: string;
    parentMessageId: string;
  },
) {
  const value = await interaction(ctx, { ...args, op: "ask" });

  if (value.kind === "denied") throw new Error(value.code);

  const { run, budget, parent } = value;

  await ctx.db.patch("subagentRuns", run._id, {
    status: "asking",
    questionMessageId: args.questionMessageId,
  });

  await ctx.db.patch("runs", budget._id, { hops: budget.hops + 1 });
  await post(ctx, parent, budget._id, args.parentMessageId, "note");

  return { status: "accepted" as const, runId: run._id };
}

/** Trusted target projection for the host's atomic native message saves. */
export const interactionContext = query({
  args: interactionArgs,
  returns: interactionResult,
  handler: (ctx, args) => interactionTarget(ctx, args),
});

/** The exact native follow-up id is saved in the inbox in the same transaction. */
export const messageChild = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    runId: v.string(),
    messageId: v.string(),
  },
  handler: (ctx, args) => sendToChild(ctx, args),
});

/** A child's question to its parent; see `askParentRun`. */
export const askParent = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    questionMessageId: v.string(),
    parentMessageId: v.string(),
  },
  handler: (ctx, args) => askParentRun(ctx, args),
});

/** Only a recorded open question can be authenticated; never scan history. */
export const questionContext = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);

    return run?.status === "asking" ? (run.questionMessageId ?? null) : null;
  },
});
