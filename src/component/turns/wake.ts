/**
 * The doorbell: publishing work to an assignment's loop workflow.
 *
 * Every transaction that can create or unblock work (accept, delivery, group
 * release, answers, finished turns, cancellation cleanup) ends by calling
 * `wake` in the same transaction. wake drains empty joined cohorts, settles
 * an idle child whose last blocker cleared (R3), reserves at most one ready
 * inbox row as the next queued turn, starts or rings the loop workflow, and
 * leaves exactly the right recovery check armed. The loop's side of the
 * doorbell is `nextQueuedTurn` (`turns.loop.next`); `reconcileDoorbell`
 * (`turns.loop.reconcile`) re-rings a loop whose ping was lost. Touches
 * `assignments`, reads the ready `inbox` range and `subagentRuns`.
 */
import type { WorkflowId } from "@convex-dev/workflow";
import { api } from "../_generated/api.js";
import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { laneManager, startLoop } from "../workflows/lanes.js";
import { firstReady } from "./inbox.js";
import { runById } from "../subagents/runs.js";
import { settleIdleParent } from "../subagents/settle.js";
import {
  armRecovery,
  cancelIfPending,
  disarmRecovery,
  needsRecovery,
  nextRecoveryDelay,
} from "./recovery.js";

/** Whether this child currently has an open question to its parent. An asking
 * child is paused (not stuck): nothing may claim or ring it until the answer
 * commits. Roots never ask. */
export async function isAsking(ctx: MutationCtx, row: Doc<"assignments">) {
  if (!row.childRunId) return false;

  const child = await runById(ctx, row.childRunId);
  return child?.status === "asking";
}

/**
 * Publish at most one ready inbox row and ring the thread's loop in the same
 * transaction as acceptance/delivery. Selection is metadata-only: claim keeps
 * deletion until after the host's native approval guard. The loop rechecks
 * this indexed queue after every child workflow, so early or duplicate events
 * can never create an extra model call. Its own reads use ring=false to avoid
 * waking itself forever when idle.
 */
export async function wake(ctx: MutationCtx, row: Doc<"assignments">, ring = true) {
  if (row.cancelled || row.turnStatus === "recovery_required") return;

  // Questions pause this child until an answer commits. Admission forbids
  // live descendants, so no descendant-result holding or bypass is necessary.
  if (await isAsking(ctx, row)) {
    await disarmRecovery(ctx, row);
    return;
  }

  row = await drainEmptyCohorts(ctx, row);

  // Re-evaluate R3 after every blocker-clearing wake, including failed delivery
  // and empty group release. Idle children cannot wait for nonexistent work.
  // answer/respond retain their inbox anchor until claim consumes it. That
  // anchor fences R3 even after the last approval is cleared; claim then marks
  // the turn running and clears lastTurnResult in the same transaction. Never
  // remove the anchor before publishing the resumed turn, or R3 could settle
  // the child with a provisional result before its answer is consumed.
  if (await settleIdleParent(ctx, row)) {
    await disarmRecovery(ctx, row);
    return;
  }

  // Failed/blocked child delivery also calls wake, but may leave no inbox work.
  // Such a doorbell would immediately lose its coalescing flag in
  // disarmRecovery and accumulate unconsumed events across loop rotation.
  const hasWork = await needsRecovery(ctx, row);
  await reserveHead(ctx, row);
  await startOrRing(ctx, row, ring && hasWork);

  // wake may have reserved the head or started a loop; use its committed row
  // so recovery follows inbox ownership even before the first awaited ping.
  const current = (await ctx.db.get("assignments", row._id))!;
  if (await needsRecovery(ctx, current)) await armRecovery(ctx, current);
  else await disarmRecovery(ctx, current);
}

/**
 * A full inbox may defer a join. Drain empty ready cohorts until either
 * work is published or no cohort remains, so several all-failed groups
 * sealed by the same last slice cannot strand an idle child. A child owns
 * one run budget: <=50 members TOTAL, <=50 indexed probes/releases,
 * <8 MiB metadata and <1,000 reads/writes at all host maxima. Root loops
 * keep their existing one-cohort cadence; claim drains ready FIFO work.
 * Returns the freshly read row after the last release.
 */
async function drainEmptyCohorts(ctx: MutationCtx, row: Doc<"assignments">) {
  const releases = row.childRunId ? row.limits.runLaunches : 1;
  for (let i = 0; i < releases; i++) {
    if (!(await ctx.runMutation(api.subagents.deliver.releaseGroups, { assignmentId: row._id })))
      break;
    row = (await ctx.db.get("assignments", row._id))!;
    if (await needsRecovery(ctx, row)) break;
  }
  return row;
}

/** Reserve the oldest ready row as the next queued turn of an idle, unpaused
 * assignment: mint its execution token and record the prompt, inbox row, run
 * and turn origin. The inbox row itself stays until claim deletes it, so
 * `queuedMessages` drops now and position math counts the reserved head. */
async function reserveHead(ctx: MutationCtx, row: Doc<"assignments">) {
  if (row.turnStatus !== "idle" || row.approvalBlocked) return;

  const next = await firstReady(ctx, row._id);
  if (!next) return;

  await ctx.db.patch("assignments", row._id, {
    turnStatus: "queued",
    turnToken: `${row._id}:${row.nextTurn}`,
    promptMessageId: next.messageId,
    inboxId: next._id,
    runId: next.runId,
    turnOrigin: next.kind === "result" || next.kind === "note" ? "subagent_result" : "user",
    nextTurn: row.nextTurn + 1,
    queuedMessages: row.queuedMessages - 1,
  });
}

/** Start the loop workflow if the assignment has none; otherwise send one
 * coalesced "ping" to a loop that is sleeping on it. `row` is the snapshot
 * wake started from: the ping guards read its pre-reservation state. */
async function startOrRing(ctx: MutationCtx, row: Doc<"assignments">, ring: boolean) {
  if (!row.workflowId) {
    const workflowId = await startLoop(ctx, row, !!row.childRunId);
    await ctx.db.patch("assignments", row._id, { workflowId });
    return;
  }

  if (
    ring &&
    row.loopWaiting &&
    !row.pinged &&
    !row.approvalBlocked &&
    row.turnStatus !== "running"
  ) {
    const manager = laneManager(!!row.childRunId, row.limits);
    await manager.sendEvent(ctx, { workflowId: row.workflowId as WorkflowId, name: "ping" });
    await ctx.db.patch("assignments", row._id, { pinged: true });
  }
}

/** The loop workflow's step: return the queued turn's token, or null after
 * recording that the loop now sleeps on its ping (`loopWaiting`). */
export async function nextQueuedTurn(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
): Promise<string | null> {
  let row = await ctx.db.get("assignments", assignmentId);
  if (!row || row.cancelled || row.turnStatus === "recovery_required") return null;
  if (row.approvalBlocked) {
    // The loop awaits ping for every null result, including approval pauses.
    // Publish that wait before returning so a fresh send can ring the loop
    // after the native approval response is recorded. No journal step changes.
    await ctx.db.patch("assignments", row._id, { pinged: false, loopWaiting: true });
    return null;
  }

  // next runs after the previous ping was consumed, or after a turn ended.
  // Keep this in the existing mutation so the versioned step order is fixed.
  await ctx.db.patch("assignments", row._id, { pinged: false, loopWaiting: false });
  if (row.turnStatus === "idle") {
    await wake(ctx, row, false);
    row = await ctx.db.get("assignments", assignmentId);
  }

  if (row?.turnStatus === "queued") return row.turnToken!;
  if (row) await ctx.db.patch("assignments", row._id, { loopWaiting: true });
  return null;
}

/**
 * Recovery lives outside the positional Workflow journal. A missing awaited
 * event can mean next's completion callback is still in flight, not that the
 * work was consumed. Keep checking through that transition with capped backoff.
 * Only Workflow's actual awaited ping permits a re-ring and a pinged reset;
 * this avoids another event/generation when resume is already in flight.
 * `recoveryAt` identifies the scheduled check; a superseded one is a no-op.
 */
export async function reconcileDoorbell(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  recoveryAt: number | undefined,
) {
  const row = await ctx.db.get("assignments", assignmentId);
  if (!row || (recoveryAt !== undefined && row.recoveryAt !== recoveryAt)) return null;
  if (!(await needsRecovery(ctx, row))) {
    await disarmRecovery(ctx, row);
    return null;
  }

  // Retire this check before arming its successor in this same transaction.
  // A stale scheduled invocation must not clear a newer check's marker.
  if (row.recoveryJobId) await cancelIfPending(ctx, row.recoveryJobId);
  await ctx.db.patch("assignments", row._id, {
    recoveryAt: undefined,
    recoveryJobId: undefined,
  });

  const status = row.workflowId
    ? await laneManager(!!row.childRunId, row.limits).status(ctx, row.workflowId as WorkflowId)
    : null;
  if (
    status?.type === "inProgress" &&
    status.running.some((step) => step.kind === "event" && step.name === "ping")
  ) {
    await ctx.db.patch("assignments", row._id, { pinged: false });
    await wake(ctx, { ...row, loopWaiting: true, pinged: false, recoveryAt: undefined });
  } else {
    await armRecovery(ctx, { ...row, recoveryAt: undefined }, nextRecoveryDelay(row));
  }
  return null;
}
