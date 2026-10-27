/** Independent root/child Workflow lanes own execution, event waits and
 * bounded journal rotation. Paid actions never retry. Workpool reports killed
 * steps through normal failure completion, with its upstream recovery latency.
 */
import { WorkflowManager, } from "@convex-dev/workflow";
import { components, internal } from "../_generated/api.js";
import { internalMutation } from "../_generated/server.js";
import { RUN_LIMITS } from "../run_settings.js";
import { LIMITS } from "../limits.js";
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
export function laneManager(child, limits) {
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
 * The default slice bound is implicit; explicit overrides travel with the loop.
 */
export function startLoop(ctx, row, child) {
    return laneManager(child, row.limits).start(ctx, child ? internal.workflows.lanes.childLoop : internal.workflows.lanes.rootLoop, {
        assignmentId: row._id,
        version: LIMITS.workflowVersion,
        ...(row.limits.slicesPerTurn !== LIMITS.slicesPerTurn
            ? { slicesPerTurn: row.limits.slicesPerTurn }
            : {}),
    }, {
        onComplete: child ? internal.workflows.lanes.childDone : internal.workflows.lanes.rootDone,
        context: { assignmentId: row._id, epoch: row.cancellationEpoch },
        startAsync: true,
    });
}
const args = {
    assignmentId: v.id("assignments"),
    version: v.number(),
    slicesPerTurn: v.optional(v.number()),
};
// Ordinary step failure returns its identity. Driver failure has no return
// value: loop.next persists the same token before handing the turn to Workflow.
// Neither path borrows a current token that could already name a successor.
const failedTurn = v.object({ executionId: v.string(), epoch: v.number() });
/** The one between-slice seam: Phase 1c can add notes/hooks without new steps. */
async function betweenSlices(step, assignmentId, executionId) {
    return step.runMutation(internal.turns.slices.betweenSlices, { assignmentId, executionId });
}
/** One turn: up to `slicesPerTurn` paid slices, each a non-retried action,
 * then `turns.slices.sliceLimit` if the model never stopped on its own. */
function defineTurn(manager) {
    return manager
        .define({ args: { ...args, executionId: v.string() }, returns: v.null() })
        .handler(async (step, args) => {
        // Positional replay in 0.4.10 has no native versioning. Preserve this branch
        // when adding a new sequence; never silently reorder a deployed version.
        if (args.version !== LIMITS.workflowVersion)
            throw new Error("UNKNOWN_WORKFLOW_VERSION");
        for (let slice = 0; slice < (args.slicesPerTurn ?? RUN_LIMITS.stepsPerTurn.max); slice++) {
            await step.runAction(internal.workflows.worker.dispatch, {
                assignmentId: args.assignmentId,
                executionId: args.executionId,
                sliceId: `${args.executionId}/${slice}`,
            }, { name: "agentStep", retry: false });
            if (!(await betweenSlices(step, args.assignmentId, args.executionId)))
                return null;
        }
        await step.runMutation(internal.turns.slices.sliceLimit, {
            assignmentId: args.assignmentId,
            executionId: args.executionId,
        });
        return null;
    });
}
/** Every created event is awaited, including the final iteration before
 * rotation. After delivery, queue admission is checked again under ownership.
 */
export function defineLoop(manager, child, inline = true) {
    return manager
        .define({ args, returns: v.union(v.null(), failedTurn) })
        .handler(async (step, args) => {
        if (args.version !== LIMITS.workflowVersion)
            throw new Error("UNKNOWN_WORKFLOW_VERSION");
        for (let turns = 0; turns < LIMITS.turnsPerLoop; turns++) {
            // Inline admission and await registration commit together, so a failed
            // driver cannot strand an event outside its journal. Tests defer this
            // step to exercise the SDK's durable early-delivery behavior too.
            const next = await step.runMutation(internal.turns.loop.next, { assignmentId: args.assignmentId, workflowId: step.workflowId }, { inline });
            if (!next)
                return null;
            if ("failure" in next)
                return next.failure;
            if ("executionId" in next) {
                try {
                    await step.runWorkflow(child ? internal.workflows.lanes.childTurn : internal.workflows.lanes.rootTurn, { ...args, executionId: next.executionId });
                }
                catch {
                    // Workpool's ordinary failed/canceled-step completion resumes here.
                    // The completion mutation owns the one atomic failure handoff.
                    return next;
                }
            }
            else
                await step.awaitEvent({ id: next.wakeEventId, name: "wake" });
        }
        return null;
    });
}
/** Completion is the single failure handoff. Finalization uses only bounded
 * exact-id native cleanup and existing settlement paths, without a repair job.
 * A thrown callback is recorded by Workflow as onCompleteFailures; it is never
 * retried by agevex. Stale old loops only clean their own journal/events.
 */
function defineDone(manager, child) {
    return internalMutation({
        args: {
            workflowId: v.string(),
            result: vResultValidator,
            context: v.object({ assignmentId: v.id("assignments"), epoch: v.number() }),
        },
        returns: v.null(),
        handler: async (ctx, { workflowId, result, context }) => {
            const row = await ctx.db.get("assignments", context.assignmentId);
            // The workflow's returns validator has already checked this payload.
            const returned = result.kind === "success" ? result.returnValue : null;
            // The loop driver can fail/cancel before it consumes a nested completion.
            // A normal rotation can also end just after a successful nested workflow
            // left its turn running. Both must settle the captured turn, while a
            // queued successor belongs to a fresh loop and must retain its token.
            const captured = row?.workflowTurnToken && (result.kind !== "success" || row.turnStatus === "running")
                ? { executionId: row.workflowTurnToken, epoch: context.epoch }
                : null;
            const failure = returned ?? captured;
            if (row?.workflowId === workflowId && row.cancellationEpoch === context.epoch) {
                if (failure)
                    await ctx.runMutation(internal.turns.failures.failWorkflow, {
                        assignmentId: row._id,
                        workflowId,
                        ...failure,
                    });
                await ctx.db.patch("assignments", row._id, {
                    workflowId: undefined,
                    workflowTurnToken: undefined,
                    wakeEventId: undefined,
                });
                if (!row.cancelled) {
                    const current = (await ctx.db.get("assignments", row._id));
                    const nextId = await startLoop(ctx, current, child);
                    await ctx.db.patch("assignments", row._id, { workflowId: nextId });
                }
            }
            await manager.cleanup(ctx, workflowId);
            return null;
        },
    });
}
/** The turn, loop and done registrations of one lane. */
function lane(child) {
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
