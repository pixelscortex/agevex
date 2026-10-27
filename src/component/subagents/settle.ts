/**
 * Settling a delegated run: the settlement fence, the R3 invariant, and the
 * registered `settlementContext`, `settle` and `escalate` endpoints.
 *
 * A child run may become terminal only when nothing can still produce work
 * for it: no ready inbox row or pending descendant delivery (`settlementBlocked`).
 * An idle child whose last blocker
 * clears settles from its recorded, host-verified last-turn outcome
 * (`settleIdleParent`, "R3") and notifies the host coordinator to deliver the
 * result upward. Called by wake, finish/failure paths, `settle`, `escalate`
 * and delivery. Touches `subagentRuns` and the root's `activeRuns`;
 * reads `inbox` and `assignments`.
 */
import { internal } from "../_generated/api.js";
import {
  type MutationCtx,
  type QueryCtx,
  mutation,
  query,
  internalMutation,
} from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { firstReady } from "../turns/inbox.js";
import { appendEvent, isSettled, runById } from "./runs.js";
import { v } from "convex/values";
import { runErrorCode } from "../schema.js";
import { settlementScope } from "./views.js";

/** Every non-terminal child retains deliveryStatus=pending; delivery can only
 * change after settlement. One indexed existence probe therefore covers live
 * descendants AND the terminal-to-delivery gap. The fence is transitive because
 * a child obeys the same rule before settling. No history scan is needed.
 */
export async function hasPendingChildren(ctx: QueryCtx | MutationCtx, parent: Doc<"assignments">) {
  return !!(await ctx.db
    .query("subagentRuns")
    .withIndex("by_parent_delivery", (q) =>
      q.eq("actorAssignmentId", parent._id).eq("deliveryStatus", "pending"),
    )
    .first());
}

/** A pending native delivery is future inbox work and fences settlement just
 * like a live descendant. Two indexed probes read <=3 KiB inbox +4 KiB run;
 * no historical prefix or native message bodies are read.
 */
export async function settlementBlocked(ctx: QueryCtx | MutationCtx, parent: Doc<"assignments">) {
  return !!(await firstReady(ctx, parent._id)) || (await hasPendingChildren(ctx, parent));
}

/** Move a live run to its terminal status if its child is not fenced, release
 * the root's active slot, and re-check R3 on the immediate parent. Returns
 * false (writing nothing) when already terminal or still blocked;
 * `settleIdleParent` and escalate rely on that to notify exactly once
 * (`recordTurnOutcome` ignores it: its settle only records the outcome). */
async function settleRunState(
  ctx: MutationCtx,
  run: Doc<"subagentRuns">,
  status: "completed" | "failed",
  errorCode: Doc<"subagentRuns">["errorCode"],
  childResultMessageId: string | undefined,
) {
  if (isSettled(run.status)) return false;

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
    ...(childResultMessageId ? { childResultMessageId } : {}),
    events: appendEvent(run.events, status, at, errorCode),
  });

  const root = await ctx.db.get("assignments", run.rootAssignmentId);

  if (root) {
    await ctx.db.patch("assignments", root._id, {
      activeRuns: Math.max(0, root.activeRuns - 1),
    });
  }

  const parent = await ctx.db.get("assignments", run.actorAssignmentId);

  if (parent) await settleIdleParent(ctx, parent);

  return true;
}

/** Schedule the host coordinator's delivery of a newly terminal run. The
 * notify action runs outside this transaction and records a failed delivery
 * if the coordinator throws. */
async function scheduleNotify(ctx: MutationCtx, run: Doc<"subagentRuns">) {
  await ctx.scheduler.runAfter(0, internal.subagents.deliver.notify, {
    runId: run._id,
    deliveryToken: run.deliveryToken,
    coordinateHandle: run.coordinateHandle,
  });
}

/** R3 is an invariant, not just a turn-end check. Delivery failure and an
 * blocked delivery can remove the last blocker without creating another turn. Use
 * only the host-verified outcome recorded by settle; a native save alone is
 * not proof that the last turn reported a valid result. The same notification
 * path propagates the terminal outcome to the next ancestor without paid work.
 * Depth <=2 bounds propagation to at most 2 * (6*16 KiB assignment reads +
 * 2*4 KiB run reads +7 KiB indexed fence probes) <=222 KiB metadata,
 * including patch reads. No native
 * bodies are read here.
 * Returns true when the child's run is (now) terminal.
 */
export async function settleIdleParent(ctx: MutationCtx, parent: Doc<"assignments">) {
  if (parent.cancelled || parent.turnStatus !== "idle" || !parent.childRunId) return false;

  const run = await runById(ctx, parent.childRunId);

  if (!run || run.status === "asking") return false;

  if (isSettled(run.status)) return true;

  const root = await ctx.db.get("assignments", run.rootAssignmentId);

  if (!root || root.cancelled || root.cancellationEpoch !== run.rootCancellationEpoch) return false;

  const result = run.lastTurnResult;
  const errorCode = result?.errorCode ?? (result?.messageId ? null : "RESULT_UNVERIFIED");

  const settled = await settleRunState(
    ctx,
    run,
    errorCode ? "failed" : "completed",
    errorCode,
    result?.messageId,
  );

  if (!settled) return false;

  await scheduleNotify(ctx, run);

  return true;
}

/** `subagents.settle.settle`: record the host-verified outcome of a child's turn and
 * settle its run if nothing fences settlement. A fenced outcome waits on the
 * run (R3 settles it later from `lastTurnResult`). Only the turn that owns
 * the token may report; anything else is FORBIDDEN. */
async function recordTurnOutcome(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<"assignments">;
    turnToken: string;
    runId: string;
    childResultMessageId: string | null;
    errorCode: Doc<"subagentRuns">["errorCode"];
  },
) {
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
}

/** `subagents.settle.escalate`: fail a live run after its child turn failed
 * terminally (turns/finish.ts failChild). Records the failure as the
 * last-turn outcome first, so a fenced run still fails once its blockers
 * clear; notifies only on the first successful settlement. */
async function escalateRun(
  ctx: MutationCtx,
  runId: string,
  code: Doc<"subagentRuns">["errorCode"] | undefined,
) {
  const run = await runById(ctx, runId);

  if (!run || isSettled(run.status)) return null;

  await ctx.db.patch("subagentRuns", run._id, {
    lastTurnResult: { errorCode: code ?? "EXECUTION_AMBIGUOUS" },
  });

  const first = await settleRunState(ctx, run, "failed", code ?? "EXECUTION_AMBIGUOUS", undefined);

  if (!first) return null;

  await scheduleNotify(ctx, run);

  return null;
}

/** What a finishing child turn needs to verify and report its result: the
 * run, its recorded final message id and whether settlement is still fenced.
 * Null unless this exact token owns the running child turn of a live run;
 * see `settlementScope` in subagents/views.ts. */
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
  handler: (ctx, args) => settlementScope(ctx, args),
});

/** Record a child turn's host-verified outcome and settle its run when
 * nothing fences it; see `recordTurnOutcome`. */
export const settle = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    runId: v.string(),
    childResultMessageId: v.union(v.string(), v.null()),
    errorCode: runErrorCode,
  },
  returns: v.null(),
  handler: (ctx, args) => recordTurnOutcome(ctx, args),
});

/** Fail a live run after its child turn failed terminally. */
export const escalate = internalMutation({
  args: { runId: v.string(), errorCode: v.optional(runErrorCode) },
  returns: v.null(),
  handler: (ctx, args) => escalateRun(ctx, args.runId, args.errorCode),
});
