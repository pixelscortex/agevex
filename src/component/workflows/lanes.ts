/**
 * The two Workflow lanes (root and child) and starting an assignment's loop.
 *
 * Each lane is its own nested Workflow component with its own Workpool, so
 * root turns and child turns never compete for the same parallelism. Used by
 * workflows.ts (step definitions and loop rotation), queue/wake.ts (start or
 * ring a loop, recovery status) and queue/cancel.ts (cancel a loop).
 */
import { WorkflowManager, type WorkflowId } from "@convex-dev/workflow";
import { components, internal } from "../_generated/api.js";
import type { MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { LIMITS, type Limits } from "../limits.js";

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
      context: { assignmentId: row._id },
      startAsync: true,
    },
  );
}
