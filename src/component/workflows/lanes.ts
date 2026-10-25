/**
 * The two Workflow lanes, their versioned step sequences, and starting an
 * assignment's loop.
 *
 * Each lane (root and child) is its own nested Workflow component with its
 * own Workpool, so root turns and child turns never compete for the same
 * parallelism. Each assignment runs one long-lived *loop* workflow: it asks
 * `turns.loop.next` for a queued turn, runs that turn as a nested *turn*
 * workflow (one `workflows.workflows.worker.dispatch` action per paid model slice,
 * separated by `turns.slices.betweenSlices`), and otherwise sleeps on a
 * "ping" event that wake sends. The *done* callback rotates finished loops
 * before their journal grows past 8 MiB. Step order here is the deployed
 * journal format: never reorder it. Also used by turns/wake.ts (start or ring
 * a loop) and turns/cancel.ts (cancel a loop). Writes `assignments`
 * (workflowId, pinged, loopWaiting); a failed loop's `done` also runs
 * `turns.failures.failWorkflow` for its in-flight turn.
 */
import { WorkflowManager, type WorkflowId, type WorkflowCtx } from "@convex-dev/workflow";
import { components, internal } from "../_generated/api.js";
import { type MutationCtx, internalMutation } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { LIMITS, type Limits } from "../limits.js";
import { v } from "convex/values";
import { vResultValidator } from "@convex-dev/workpool";

// Workflow 0.4.10's StepExecutor.startSteps calls createFunctionHandle for
// function steps, and Convex accepts an existing opaque handle there. Therefore
// workflows can live inside this component: workflows.worker.dispatch resolves the host
// runTurn handle without requiring host workflow exports or another mount.
// Separate nested Workflow components give real independent Workpool lanes.
export const rootLane = new WorkflowManager(components.rootWorkflow, {
  workpoolOptions: {
    retryActionsByDefault: false,
    logLevel: "ERROR",
  },
});
export const childLane = new WorkflowManager(components.childWorkflow, {
  workpoolOptions: {
    retryActionsByDefault: false,
    logLevel: "ERROR",
  },
});

/**
 * Set lane capacity through Workflow's supported async start API. Definitions
 * leave maxParallelism unset so nested turns inherit the mounted lane's config
 * instead of resetting a host override to the SDK default on every turn.
 * A mount owns one pair of lanes; registrations sharing it must share capacity.
 */
export function laneManager(child: boolean, limits: Pick<Limits, "rootLane" | "childLane">) {
  return new WorkflowManager(child ? components.childWorkflow : components.rootWorkflow, {
    workpoolOptions: {
      maxParallelism: child ? limits.childLane : limits.rootLane,
      retryActionsByDefault: false,
      logLevel: "ERROR",
    },
  });
}

/**
 * Start an assignment's loop workflow in its lane and return the workflow id
 * (the caller records it on the row in the same transaction). Called by wake
 * when no loop exists and by the done callback to rotate a finished loop.
 * `slicesPerTurn` is passed only when the host overrode it, so default rows
 * keep the original version-1 argument shape.
 */
export function startLoop(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  child: boolean,
): Promise<WorkflowId> {
  return laneManager(child, row.limits).start(
    ctx,
    child ? internal.workflows.lanes.childLoop : internal.workflows.lanes.rootLoop,
    {
      assignmentId: row._id,
      version: LIMITS.workflowVersion,
      ...(row.limits.slicesPerTurn !== LIMITS.slicesPerTurn
        ? { slicesPerTurn: row.limits.slicesPerTurn }
        : {}),
    },
    {
      onComplete: child ? internal.workflows.lanes.childDone : internal.workflows.lanes.rootDone,
      context: { assignmentId: row._id },
      startAsync: true,
    },
  );
}

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
  return step.runMutation(internal.turns.slices.betweenSlices, { assignmentId, executionId });
}

/** One turn: up to `slicesPerTurn` paid slices, each a non-retried action,
 * then `turns.slices.sliceLimit` if the model never stopped on its own. */
function defineTurn(manager: WorkflowManager) {
  return manager
    .define({ args: { ...args, executionId: v.string() }, returns: v.null() })
    .handler(async (step, args): Promise<null> => {
      // Positional replay in 0.4.10 has no native versioning. Preserve this branch
      // when adding a new sequence; never silently reorder a deployed version.
      if (args.version !== LIMITS.workflowVersion) throw new Error("UNKNOWN_WORKFLOW_VERSION");

      for (let slice = 0; slice < (args.slicesPerTurn ?? LIMITS.slicesPerTurn); slice++) {
        await step.runAction(
          internal.workflows.worker.dispatch,
          {
            assignmentId: args.assignmentId,
            executionId: args.executionId,
            sliceId: `${args.executionId}/${slice}`,
          },
          { name: "agentStep", retry: false },
        );
        if (!(await betweenSlices(step, args.assignmentId, args.executionId))) return null;
      }

      await step.runMutation(internal.turns.slices.sliceLimit, {
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
      const executionId: string | null = await step.runMutation(internal.turns.loop.next, {
        assignmentId: args.assignmentId,
      });
      if (executionId)
        await step.runWorkflow(
          child ? internal.workflows.lanes.childTurn : internal.workflows.lanes.rootTurn,
          {
            ...args,
            executionId,
          },
        );
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
          await ctx.runMutation(internal.turns.failures.failWorkflow, {
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
