/**
 * The two Workflow lanes and their versioned step sequences.
 *
 * Each assignment runs one long-lived *loop* workflow (root or child lane):
 * it asks `queue.next` for a queued turn, runs that turn as a nested *turn*
 * workflow (one `worker.dispatch` action per paid model slice, separated by
 * `queue.betweenSlices`), and otherwise sleeps on a "ping" event that wake
 * sends. The *done* callback rotates finished loops before their journal grows
 * past 8 MiB. Step order here is the deployed journal format: never reorder it.
 * The lane managers and loop start live in workflows/lanes.ts. Touches only
 * `assignments` (workflowId, pinged, loopWaiting).
 */
import type { WorkflowManager, WorkflowCtx, WorkflowId } from "@convex-dev/workflow";
import { v } from "convex/values";
import { vResultValidator } from "@convex-dev/workpool";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { LIMITS } from "./limits.js";
import { childLane, rootLane, startLoop } from "./workflows/lanes.js";

const args = {
  assignmentId: v.id("assignments"),
  version: v.number(),
  slicesPerTurn: v.optional(v.number()),
};

/** The one between-slice seam: Phase 1c can add notes/hooks without new steps. */
async function betweenSlices(
  step: WorkflowCtx,
  assignmentId: Id<"assignments">,
  executionId: string,
) {
  return step.runMutation(internal.queue.betweenSlices, { assignmentId, executionId });
}

/** One turn: up to `slicesPerTurn` paid slices, each a non-retried action,
 * then `queue.sliceLimit` if the model never stopped on its own. */
function defineTurn(manager: WorkflowManager) {
  return manager
    .define({ args: { ...args, executionId: v.string() }, returns: v.null() })
    .handler(async (step, args): Promise<null> => {
      // Positional replay in 0.4.10 has no native versioning. Preserve this branch
      // when adding a new sequence; never silently reorder a deployed version.
      if (args.version !== LIMITS.workflowVersion) throw new Error("UNKNOWN_WORKFLOW_VERSION");

      for (let slice = 0; slice < (args.slicesPerTurn ?? LIMITS.slicesPerTurn); slice++) {
        await step.runAction(
          internal.worker.dispatch,
          {
            assignmentId: args.assignmentId,
            executionId: args.executionId,
            sliceId: `${args.executionId}/${slice}`,
          },
          { name: "agentStep", retry: false },
        );
        if (!(await betweenSlices(step, args.assignmentId, args.executionId))) return null;
      }

      await step.runMutation(internal.queue.sliceLimit, {
        assignmentId: args.assignmentId,
        executionId: args.executionId,
      });
      return null;
    });
}

/** The bounded loop: `turnsPerLoop` iterations of "run the queued turn, or
 * sleep until wake's ping", then completion and rotation via done. */
function defineLoop(manager: WorkflowManager, child: boolean) {
  return manager.define({ args, returns: v.null() }).handler(async (step, args): Promise<null> => {
    if (args.version !== LIMITS.workflowVersion) throw new Error("UNKNOWN_WORKFLOW_VERSION");

    for (let turns = 0; turns < LIMITS.turnsPerLoop; turns++) {
      const executionId: string | null = await step.runMutation(internal.queue.next, {
        assignmentId: args.assignmentId,
      });
      if (executionId)
        await step.runWorkflow(child ? internal.workflows.childTurn : internal.workflows.rootTurn, {
          ...args,
          executionId,
        });
      else await step.awaitEvent({ name: "ping" });
    }
    return null;
  });
}

/** Loop completion: a failed loop marks its in-flight turn ambiguous; a
 * finished loop is replaced by a fresh one and its journal cleaned up. Only
 * the row's current, uncancelled workflow may do either. */
function defineDone(manager: WorkflowManager, child: boolean) {
  return internalMutation({
    args: {
      workflowId: v.string(),
      result: vResultValidator,
      context: v.object({ assignmentId: v.id("assignments") }),
    },
    returns: v.null(),
    handler: async (ctx, { workflowId, result, context }): Promise<null> => {
      const row = await ctx.db.get("assignments", context.assignmentId);
      if (!row || row.workflowId !== workflowId || row.cancelled) return null;

      await ctx.db.patch("assignments", row._id, {
        workflowId: undefined,
        pinged: false,
        loopWaiting: false,
      });

      if (result.kind !== "success") {
        if (row.turnToken)
          await ctx.runMutation(internal.queue.failWorkflow, {
            assignmentId: row._id,
            executionId: row.turnToken,
          });
        return null;
      }

      // Rotate bounded loops before the journal reaches 8 MiB. Idle loops stay
      // asleep on events; rotation consumes no model work or inbox rows.
      const nextId = await startLoop(ctx, row, child);
      await ctx.db.patch("assignments", row._id, { workflowId: nextId });

      // 0.4.10 exposes no event deletion API, and cleanup deletes only events
      // referenced by journal steps (workflow.ts/deleteSteps). wake sends only
      // to a sleeping loop with no pending ping; next clears that flag after
      // consumption. Therefore rotation has no surplus SDK events to delete.
      await manager.cleanup(ctx, workflowId as WorkflowId);
      return null;
    },
  });
}

/** The turn, loop and done registrations of one lane. */
function lane(child: boolean) {
  const manager = child ? childLane : rootLane;
  return {
    turn: defineTurn(manager),
    loop: defineLoop(manager, child),
    done: defineDone(manager, child),
  };
}

const root = lane(false);
const child = lane(true);
export const rootTurn = root.turn;
export const rootLoop = root.loop;
export const rootDone = root.done;
export const childTurn = child.turn;
export const childLoop = child.loop;
export const childDone = child.done;
