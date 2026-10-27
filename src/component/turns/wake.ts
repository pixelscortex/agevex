/** Exact Workflow events connect queue admission to the assignment loop.
 * Queue checks and producers serialize on the assignment row: an event can
 * be delivered before awaitEvent registers and Workflow retains that delivery.
 */
import { approvalBlocked } from "../approvals.js";
import type { EventId, WorkflowId } from "@convex-dev/workflow";
import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { laneManager, startLoop } from "../workflows/lanes.js";
import { firstReady, readyRows } from "./inbox.js";
import { readyRowLimit } from "../limits.js";
import { runById } from "../subagents/runs.js";
import { settleIdleParent } from "../subagents/settle.js";
import { closeRootRun } from "./run_lifecycle.js";

/** A question pauses child admission until its answer commits. */
export async function isAsking(ctx: MutationCtx, row: Doc<"assignments">) {
  if (!row.childRunId) return false;

  return (await runById(ctx, row.childRunId))?.status === "asking";
}

/** Publish claimable work in the producer's transaction. Never create a new
 * event here: only the loop's empty-queue transaction owns event creation.
 * Re-read after reservation so event delivery sees the committed turn token.
 */
export async function wake(ctx: MutationCtx, row: Doc<"assignments">) {
  if (row.cancelled || row.turnStatus === "recovery_required" || (await isAsking(ctx, row))) return;

  await closeRootRun(ctx, row);

  // A resumed answer/approval keeps its inbox anchor until claim; otherwise
  // R3 could settle a child before its continuation is consumed.
  if (await settleIdleParent(ctx, row)) return;

  await reserveHead(ctx, row);
  const current = (await ctx.db.get("assignments", row._id))!;

  if (current.turnStatus !== "queued" || approvalBlocked(current)) return;

  if (!current.workflowId) {
    const workflowId = await startLoop(ctx, current, !!current.childRunId);

    await ctx.db.patch("assignments", current._id, { workflowId });
  } else if (current.wakeEventId) {
    await laneManager(!!current.childRunId, current.limits).sendEvent(ctx, {
      id: current.wakeEventId as EventId,
    });

    await ctx.db.patch("assignments", current._id, { wakeEventId: undefined });
  }
}

/** Reserve at most one ready head, preserving FIFO and the native prompt.
 * The row remains until claim's approval guard accepts it; queuedMessages
 * excludes this reserved head from this point onward.
 */
async function reserveHead(ctx: MutationCtx, row: Doc<"assignments">) {
  if (row.turnStatus !== "idle" || approvalBlocked(row)) return;

  const next = await firstClaimable(ctx, row);

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

/** Retire only queue metadata belonging to an ambiguous, terminal root
 * request. Native results remain in history; note origins remain addressable.
 * This also fences late deliveries after an unrelated request has resumed.
 * <=152 ready rows (1 KiB each) and <=152 exact run reads (16 KiB each),
 * memoized by run, plus <=152 patch/delete reads. No native bodies are read.
 */
export async function firstClaimable(ctx: MutationCtx, row: Doc<"assignments">) {
  if (row.childRunId) return firstReady(ctx, row._id);

  const failed = new Map<Id<"runs">, boolean>();
  const ready = await readyRows(ctx, row._id, readyRowLimit(row.limits));
  let retired = 0;
  let next: Doc<"inbox"> | null = null;

  for (const item of ready) {
    if (!failed.has(item.runId)) {
      const run = await ctx.db.get("runs", item.runId);

      failed.set(
        item.runId,
        run?.finishedAt !== undefined && run.errorCode === "EXECUTION_AMBIGUOUS",
      );
    }

    if (!failed.get(item.runId)) {
      next = item;
      break;
    }

    if (item.kind === "note" && item.from)
      await ctx.db.patch("inbox", item._id, { passive: false });
    else await ctx.db.delete("inbox", item._id);

    retired++;
  }

  if (retired) {
    row.queuedMessages -= retired;
    await ctx.db.patch("assignments", row._id, { queuedMessages: row.queuedMessages });
  }

  return next;
}

export type NextTurn = { executionId: string; epoch: number } | { wakeEventId: string } | null;

/** Atomically reserve work or create the exact event this loop must await.
 * Old loops stop cooperatively after cancel, including when cancellation
 * races the gap between this mutation and awaitEvent registration. That lets
 * every created event enter the journal before SDK cleanup deletes it.
 */
export async function nextQueuedTurn(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  workflowId: string,
): Promise<NextTurn> {
  let row = await ctx.db.get("assignments", assignmentId);

  if (!row || row.workflowId !== workflowId || row.cancelled) return null;

  if (!approvalBlocked(row) && row.turnStatus !== "recovery_required") {
    await wake(ctx, row);
    row = (await ctx.db.get("assignments", assignmentId))!;

    if (row.turnStatus === "queued" && !(await isAsking(ctx, row)))
      return { executionId: row.turnToken!, epoch: row.cancellationEpoch };
  }

  const wakeEventId = await laneManager(!!row.childRunId, row.limits).createEvent(ctx, {
    workflowId: workflowId as WorkflowId,
    name: "wake",
  });

  await ctx.db.patch("assignments", row._id, { wakeEventId });

  return { wakeEventId };
}
