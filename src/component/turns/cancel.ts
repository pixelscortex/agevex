/**
 * `cancel`: stop a root thread and every live descendant in ONE bounded
 * transaction.
 *
 * Cancel sets fences before it cancels Workflow (which cannot abort a running
 * action): each affected assignment gets a new cancellation epoch, is idled,
 * loses its ready inbox rows and run budget, and has its loop workflow
 * cancelled; every live delegation fails with ROOT_UNAVAILABLE. Work that
 * cannot fit the budget (unsaved note bodies, pending native placeholders,
 * approval cleanup) is handed to finite jobs (hooks.notes.cancelNotes,
 * cancellation.cleanup.cleanup). The full read/write arithmetic is in
 * limits.ts. Touches `assignments`, `inbox`, `runs` and `subagentRuns`.
 */
import type { WorkflowId } from "@convex-dev/workflow";
import { internal } from "../_generated/api.js";
import { type MutationCtx, mutation } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { appendEvent } from "../subagents/runs.js";
import { childLane, rootLane } from "../workflows/lanes.js";
import { readyRows } from "./inbox.js";
import { disarmRecovery } from "./recovery.js";
import { disarmSlice } from "./boundaries.js";
import { v } from "convex/values";

/** Cancel the root thread owned by `subject` and all its live descendants.
 * Returns the affected native threads so the host can abort their streams. */
export async function cancelRoot(
  ctx: MutationCtx,
  args: { assignmentId: Id<"assignments">; subject: string },
) {
  const root = await ctx.db.get("assignments", args.assignmentId);

  if (!root || root.subject !== args.subject || root.childRunId) throw new Error("FORBIDDEN");

  const children = await liveChildren(ctx, root);

  const affected = [
    root,
    ...(
      await Promise.all(
        // Promise.all accepts null placeholders for children without assignments.
        // eslint-disable-next-line typescript/await-thenable
        children.map((run) =>
          run.childAssignmentId ? ctx.db.get("assignments", run.childAssignmentId) : null,
        ),
      )
    ).filter((row): row is Doc<"assignments"> => row !== null),
  ];

  for (const row of affected) await cancelAssignment(ctx, row);

  for (const run of children) {
    await ctx.db.patch("subagentRuns", run._id, {
      status: "failed",
      deliveryStatus: "blocked",
      errorCode: "ROOT_UNAVAILABLE",
      lastTurnResult: undefined,
      // No delivery event: a blocked delivery ends with this terminal event,
      // which is where `runTimes` reads its deliveryAt.
      events: appendEvent(run.events, "failed", Date.now(), "ROOT_UNAVAILABLE"),
    });
  }

  await ctx.db.patch("assignments", root._id, {
    activeRuns: 0,
  });

  return affected.map((row) => ({ threadId: row.threadId, agent: row.agent }));
}

/** Every queued, running or asking delegation under this root: three exact
 * status ranges, each capped at the root's active-children bound. */
async function liveChildren(ctx: MutationCtx, root: Doc<"assignments">) {
  return (
    await Promise.all(
      (["queued", "running", "asking"] as const).map((status) =>
        ctx.db
          .query("subagentRuns")
          .withIndex("by_root_status", (q) =>
            q.eq("rootAssignmentId", root._id).eq("status", status),
          )
          .take(root.limits.activeChildrenPerRoot),
      ),
    )
  ).flat();
}

/** Fence and idle one assignment, then drop its ready work. `row` is the
 * pre-cancel snapshot: the staged continuation, pending generation, notes,
 * run and workflow it names are the ones cleaned up here. */
async function cancelAssignment(ctx: MutationCtx, row: Doc<"assignments">) {
  await disarmSlice(ctx, row);
  await disarmRecovery(ctx, row);

  const approvalCleanup = !!row.approvals?.requests.length;

  await ctx.db.patch("assignments", row._id, cancelledState(row, approvalCleanup));

  // Only ready rows are read here. Raw passive bodies are cleared by one
  // bounded job per assignment, preserving the 12,680 KiB cancel ceiling.
  const inbox = await readyRows(ctx, row._id, row.limits.queueLength + 2);

  // A staged hook continuation is addressed directly, never included in a
  // backlog scan. <=16 assignments * (64 KiB text +1 KiB metadata) read
  // for deletion adds <=1,040 KiB to the 12,680 KiB cancel budget: <14 MiB.
  if (row.hookContinue && row.inboxId) await ctx.db.delete("inbox", row.inboxId);

  await scheduleCleanup(ctx, row, approvalCleanup);

  for (const item of inbox) {
    await ctx.db.patch("runs", item.runId, { cancelled: true });
    await ctx.db.delete("inbox", item._id);
  }

  if (row.runId) await ctx.db.patch("runs", row.runId, { cancelled: true });

  if (row.workflowId)
    await (row.childRunId ? childLane : rootLane).cancel(ctx, row.workflowId as WorkflowId);
}

/** The cancelled, idle state: a new epoch fences every late write, all turn
 * and queue state is cleared, and a recorded approval pause stays blocked
 * (`cleanupPending`) until cancellation cleanup has denied each request. */
function cancelledState(row: Doc<"assignments">, approvalCleanup: boolean) {
  return {
    cancelled: true,
    cancellationEpoch: row.cancellationEpoch + 1,
    turnStatus: "idle" as const,
    errorCode: null,
    turnToken: undefined,
    promptMessageId: undefined,
    inboxId: undefined,
    workflowId: undefined,
    loopWaiting: false,
    pinged: false,
    queuedMessages: 0,
    notesPending: 0,
    hookContinue: false,
    approvalBlocked: !!approvalCleanup,
    approvals: approvalCleanup ? { ...row.approvals!, cleanupPending: true } : undefined,
  };
}

/** Hand the out-of-budget cleanup to finite jobs: unsaved note bodies of the
 * old epoch (hooks.notes.cancelNotes) and the pending placeholder/stream plus
 * approval denials (cancellation.cleanup.cleanup). */
async function scheduleCleanup(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  approvalCleanup: boolean,
) {
  if (row.notesPending)
    await ctx.scheduler.runAfter(0, internal.hooks.notes.cancelNotes, {
      assignmentId: row._id,
      epoch: row.cancellationEpoch,
    });

  if (row.pendingGeneration || approvalCleanup)
    await ctx.scheduler.runAfter(0, internal.cancellation.cleanup.cleanup, {
      assignmentId: row._id,
      pending: row.pendingGeneration,
      approvalEpoch: approvalCleanup ? row.approvals!.epoch : undefined,
    });
}

/** Cancel sets fences before canceling Workflow, which cannot abort actions.
 * See `cancelRoot`. */
export const cancel = mutation({
  args: { assignmentId: v.id("assignments"), subject: v.string() },
  returns: v.array(v.object({ threadId: v.string(), agent: v.string() })),
  handler: (ctx, args) => cancelRoot(ctx, args),
});
