import { WorkflowManager, type WorkflowCtx, type WorkflowId } from "@convex-dev/workflow";
import { v } from "convex/values";
import { vResultValidator } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { LIMITS, type Limits } from "./limits.js";

// Workflow 0.4.10's StepExecutor.startSteps calls createFunctionHandle for
// function steps, and Convex accepts an existing opaque handle there. Therefore
// workflows can live inside this component: worker.dispatch resolves the host
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

function lane(child: boolean) {
  const manager = child ? childLane : rootLane;
  const turn = manager
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
  const loop = manager
    .define({ args, returns: v.null() })
    .handler(async (step, args): Promise<null> => {
      if (args.version !== LIMITS.workflowVersion) throw new Error("UNKNOWN_WORKFLOW_VERSION");
      for (let turns = 0; turns < LIMITS.turnsPerLoop; turns++) {
        const executionId: string | null = await step.runMutation(internal.queue.next, {
          assignmentId: args.assignmentId,
        });
        if (executionId)
          await step.runWorkflow(
            child ? internal.workflows.childTurn : internal.workflows.rootTurn,
            { ...args, executionId },
          );
        else await step.awaitEvent({ name: "ping" });
      }
      return null;
    });
  const done = internalMutation({
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
      const nextId = await laneManager(child, row.limits).start(
        ctx,
        child ? internal.workflows.childLoop : internal.workflows.rootLoop,
        {
          assignmentId: row._id,
          version: LIMITS.workflowVersion,
          ...(row.limits.slicesPerTurn !== LIMITS.slicesPerTurn
            ? { slicesPerTurn: row.limits.slicesPerTurn }
            : {}),
        },
        {
          onComplete: child ? internal.workflows.childDone : internal.workflows.rootDone,
          context,
          startAsync: true,
        },
      );
      await ctx.db.patch("assignments", row._id, { workflowId: nextId });
      // 0.4.10 exposes no event deletion API, and cleanup deletes only events
      // referenced by journal steps (workflow.ts/deleteSteps). wake sends only
      // to a sleeping loop with no pending ping; next clears that flag after
      // consumption. Therefore rotation has no surplus SDK events to delete.
      await manager.cleanup(ctx, workflowId as WorkflowId);
      return null;
    },
  });
  return { turn, loop, done };
}
const root = lane(false);
const child = lane(true);
export const rootTurn = root.turn;
export const rootLoop = root.loop;
export const rootDone = root.done;
export const childTurn = child.turn;
export const childLoop = child.loop;
export const childDone = child.done;
