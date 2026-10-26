/**
 * Launching a delegation: the trusted `delegateContext` of a running turn,
 * admission (`reserve`) and attaching the native child thread (`attach`).
 *
 * `reserveRun` checks, in order: the turn still owns its token, root and
 * parent run are live in the current epoch, depth and group arguments are
 * valid, the tool call was not already reserved (idempotent replay), the root
 * has a free active slot, the run budget has a launch/hop (or side-run) left,
 * the assignment has outstanding-result headroom across requests, and the named
 * cohort accepts another member. Success spends the budget and
 * inserts the queued run in the same transaction as the host's native
 * child-thread creation. `attachChild` then creates the child assignment with
 * its task as the first inbox row and wakes it. Touches `subagentRuns`,
 * `runs`, `assignments`, `inbox` and the root's delegation counters.
 */
import { type ObjectType, v } from "convex/values";
import { type MutationCtx, mutation, query } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { denialCode } from "../schema.js";
import { LIMITS } from "../limits.js";
import { assertFunctionHandle, assertName } from "../facts.js";
import { taskPreview } from "../run-tree-values.js";
import { approvalKey } from "../approvals.js";
import { assertRunMetadata, groupMembers, newSubagentRun, runById } from "./runs.js";
import { messageRef, recordRefs } from "../hooks/refs.js";
import { newChildAssignment } from "../turns/assignments.js";
import { wake } from "../turns/wake.js";
import { delegateScope } from "./views.js";
import { canOweResult, reserveFor } from "./headroom.js";

export const reserveArgs = {
  assignmentId: v.id("assignments"),
  turnToken: v.string(),
  toolCallId: v.string(),
  agent: v.string(),
  payloadFingerprint: v.string(),
  coordinateHandle: v.string(),
  side: v.optional(v.boolean()),
  group: v.optional(v.string()),
  wait: v.optional(v.union(v.literal("each"), v.literal("all"))),
};

export const reservation = v.union(
  v.object({ kind: v.literal("reserved"), runId: v.string() }),
  v.object({ kind: v.literal("replay"), runId: v.string(), agent: v.string() }),
  v.object({ kind: v.literal("denied"), code: denialCode }),
);

type ReserveArgs = ObjectType<typeof reserveArgs>;
type Denial = { kind: "denied"; code: typeof denialCode.type };

const denied = <Code extends Denial["code"]>(code: Code) => ({ kind: "denied" as const, code });

/**
 * Reservation, run-budget spend and active-child count commit with the host's
 * native child thread creation. Dedup precedes admission limits so a repeated
 * callback can recover its original receipt even at capacity. Result turns
 * retain the originating user run; only a new user prompt creates new budget.
 * Root counters include every descendant. Depth is checked from the immediate
 * parent run, so a shared child definition cannot bypass the configured bound.
 */
export async function reserveRun(ctx: MutationCtx, args: ReserveArgs) {
  // The agent name becomes the child assignment's `agent`; the handle is
  // stored on the run row. Bound both before any read or write.
  assertName(args.agent, "agent");
  assertFunctionHandle(args.coordinateHandle, "coordinateHandle");

  const scope = await reservationScope(ctx, args);

  if (scope.kind === "denied") return scope;

  const { row, root, depth } = scope;

  const dedupKey = `${row._id}:${args.turnToken}:${await approvalKey(args.toolCallId)}`;

  const duplicate = await ctx.db
    .query("subagentRuns")
    .withIndex("by_dedup", (q) => q.eq("dedupKey", dedupKey))
    .unique();

  if (duplicate) {
    if (duplicate.payloadFingerprint !== args.payloadFingerprint)
      return denied("DELEGATION_CONFLICT");

    return { kind: "replay" as const, runId: duplicate.runId, agent: duplicate.agent };
  }

  if (root.activeRuns >= root.limits.activeChildrenPerRoot) return denied("ACTIVE_LIMIT");

  // A delivered-result turn retains this run id: completing a child cannot
  // replenish launches, and a new caller prompt alone creates a new budget.
  const budget = row.runId ? await ctx.db.get("runs", row.runId) : null;

  if (!budget || budget.cancelled || budgetSpent(budget, row, args.side))
    return denied("RUN_BUDGET");

  if (!args.side) {
    const refusal = await reserveFor(ctx, "launch", root, budget);

    if (refusal) return refusal;

    if (!(await canOweResult(ctx, row, root))) return denied("RUN_BUDGET");
  }

  const wait = args.wait ?? "each";
  const group = args.group ?? (wait === "all" ? "" : undefined);

  if (group !== undefined) {
    const refusal = await cohortRefusal(ctx, budget._id, row, root, group, wait);

    if (refusal) return refusal;
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

  await ctx.db.insert(
    "subagentRuns",
    newSubagentRun({
      request: args,
      runId,
      actor: row,
      root,
      budget,
      depth,
      group,
      wait,
      dedupKey,
      sequence,
      now,
    }),
  );

  await ctx.db.patch("assignments", root._id, {
    activeRuns: root.activeRuns + 1,
    nextRunSequence: sequence,
  });

  return { kind: "reserved" as const, runId };
}

/** The checks that need no dedup key: the calling turn still owns its token,
 * the root (and, for a child caller, its own running run) is live in the
 * root's epoch, the depth bound holds and side/group arguments are valid. */
async function reservationScope(ctx: MutationCtx, args: ReserveArgs) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (!row || row.turnToken !== args.turnToken || row.turnStatus !== "running")
    return denied("STALE_TURN");

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
    return denied("FORBIDDEN");

  const depth = parent ? parent.depth + 1 : 1;

  if (depth > root.limits.maxDepth) return denied("DEPTH_LIMIT");

  if (args.side && (args.group !== undefined || args.wait !== undefined))
    return denied("GROUP_CONFLICT");

  if ((args.group?.length ?? 0) > LIMITS.groupLength) return denied("TASK_LIMIT");

  return { kind: "scope" as const, row, root, depth };
}

/** Whether this launch would exceed the run budget: side reviews spend
 * `sideRuns`; ordinary launches spend one launch and one hop, with final-result
 * headroom checked by reserveFor before any write. */
function budgetSpent(budget: Doc<"runs">, row: Doc<"assignments">, side: boolean | undefined) {
  return side
    ? budget.sideRuns >= row.limits.sideRunsPerRun
    : budget.launches >= row.limits.runLaunches;
}

/** A named group is a closed cohort, capped INCLUDING settled members. Refuse
 * mixing wait modes, joining a sealed cohort, or exceeding the cohort cap. */
async function cohortRefusal(
  ctx: MutationCtx,
  budgetId: Id<"runs">,
  row: Doc<"assignments">,
  root: Doc<"assignments">,
  group: string,
  wait: "each" | "all",
) {
  // <=15 small rows (<=4 KiB each) + two <=34 KiB assignments and fixed
  // admission metadata <160 KiB; no native
  // result bodies are read. Index scope excludes every other parent/run.
  const members = await groupMembers(
    ctx,
    { parentRunId: budgetId, actorAssignmentId: row._id, group },
    wait === "all" ? root.limits.activeChildrenPerRoot : 1,
  );

  if (members.some((member) => (member.join ? "all" : "each") !== wait))
    return denied("GROUP_CONFLICT");

  // Sealing is one-way (sealed -> ready -> joined), so any state past
  // "open" means the launching slice already closed this cohort.
  if (members.some((member) => member.join && member.join !== "open"))
    return denied("GROUP_CLOSED");

  if (wait === "all" && members.length >= root.limits.activeChildrenPerRoot)
    return denied("GROUP_LIMIT");

  return null;
}

export const attachArgs = {
  runId: v.string(),
  childThreadId: v.string(),
  promptMessageId: v.string(),
  task: v.optional(v.string()),
  savedMessage: v.optional(messageRef),
  trackContext: v.optional(v.boolean()),
};

/**
 * Queue a native child in its independent lane. Keeping the task in Agent and
 * only the message id in the inbox avoids placing task bodies in Workflow's
 * 800 KiB step values. The parent's short launch mutation never waits for a
 * child action, leaving scheduler capacity available for those children.
 * Idempotent: an already attached run is a no-op.
 */
export async function attachChild(ctx: MutationCtx, args: ObjectType<typeof attachArgs>) {
  const run = await runById(ctx, args.runId);

  if (!run || run.childAssignmentId) return null;

  if (run.status !== "queued") throw new Error("INVALID_LAUNCH");

  const root = await ctx.db.get("assignments", run.rootAssignmentId);

  if (!root || root.cancelled || root.cancellationEpoch !== run.rootCancellationEpoch)
    throw new Error("ROOT_UNAVAILABLE");

  const childId = await ctx.db.insert(
    "assignments",
    newChildAssignment({
      root,
      run,
      childThreadId: args.childThreadId,
      trackContext: args.trackContext,
    }),
  );

  await ctx.db.insert("inbox", {
    assignmentId: childId,
    messageId: args.promptMessageId,
    sequence: 0,
    kind: "user",
    runId: run.parentRunId,
  });

  const attached = {
    taskMessageId: args.promptMessageId,
    taskPreview: taskPreview(args.task ?? ""),
    childAssignmentId: childId,
    childThreadId: args.childThreadId,
  };

  assertRunMetadata({ ...run, ...attached });
  await ctx.db.patch("subagentRuns", run._id, attached);

  if (args.savedMessage)
    await recordRefs(ctx, (await ctx.db.get("assignments", childId))!, [args.savedMessage]);

  await wake(ctx, (await ctx.db.get("assignments", childId))!);

  return null;
}

/** Trusted root context for a running turn that wants to delegate. */
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
  handler: (ctx, args) => delegateScope(ctx, args),
});

/** Admit one delegation and spend its budget; see `reserveRun`. */
export const reserve = mutation({
  args: reserveArgs,
  returns: reservation,
  handler: (ctx, args) => reserveRun(ctx, args),
});

/** Create the child assignment for a reserved run's native thread and queue
 * its task; see `attachChild`. */
export const attach = mutation({
  args: attachArgs,
  returns: v.null(),
  handler: (ctx, args) => attachChild(ctx, args),
});
