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
import { WorkflowManager, type WorkflowId } from "@convex-dev/workflow";
import { type MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { type Limits } from "../limits.js";
export declare const rootLane: WorkflowManager;
export declare const childLane: WorkflowManager;
/**
 * Set lane capacity through Workflow's supported async start API. Definitions
 * leave maxParallelism unset so nested turns inherit the mounted lane's config
 * instead of resetting a host override to the SDK default on every turn.
 * A mount owns one pair of lanes; registrations sharing it must share capacity.
 */
export declare function laneManager(child: boolean, limits: Pick<Limits, "rootLane" | "childLane">): WorkflowManager;
/**
 * Start an assignment's loop workflow in its lane and return the workflow id
 * (the caller records it on the row in the same transaction). Called by wake
 * when no loop exists and by the done callback to rotate a finished loop.
 * `slicesPerTurn` is passed only when the host overrode it, so default rows
 * keep the original version-1 argument shape.
 */
export declare function startLoop(ctx: MutationCtx, row: Doc<"assignments">, child: boolean): Promise<WorkflowId>;
export declare const rootTurn: import("convex/server").RegisteredMutation<"internal", import("@convex-dev/workflow").WorkflowArgs<{
    executionId: import("convex/values").VString<string, "required">;
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    version: import("convex/values").VFloat64<number, "required">;
    slicesPerTurn: import("convex/values").VFloat64<number | undefined, "optional">;
}>, import("@convex-dev/workflow").WorkflowMutationResult<null>>;
export declare const rootLoop: import("convex/server").RegisteredMutation<"internal", import("@convex-dev/workflow").WorkflowArgs<{
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    version: import("convex/values").VFloat64<number, "required">;
    slicesPerTurn: import("convex/values").VFloat64<number | undefined, "optional">;
}>, import("@convex-dev/workflow").WorkflowMutationResult<null>>;
export declare const rootDone: import("convex/server").RegisteredMutation<"internal", {
    workflowId: string;
    result: {
        kind: "success";
        returnValue: any;
    } | {
        kind: "failed";
        error: string;
    } | {
        kind: "canceled";
    };
    context: {
        assignmentId: import("convex/values").GenericId<"assignments">;
    };
}, Promise<null>>;
export declare const childTurn: import("convex/server").RegisteredMutation<"internal", import("@convex-dev/workflow").WorkflowArgs<{
    executionId: import("convex/values").VString<string, "required">;
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    version: import("convex/values").VFloat64<number, "required">;
    slicesPerTurn: import("convex/values").VFloat64<number | undefined, "optional">;
}>, import("@convex-dev/workflow").WorkflowMutationResult<null>>;
export declare const childLoop: import("convex/server").RegisteredMutation<"internal", import("@convex-dev/workflow").WorkflowArgs<{
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    version: import("convex/values").VFloat64<number, "required">;
    slicesPerTurn: import("convex/values").VFloat64<number | undefined, "optional">;
}>, import("@convex-dev/workflow").WorkflowMutationResult<null>>;
export declare const childDone: import("convex/server").RegisteredMutation<"internal", {
    workflowId: string;
    result: {
        kind: "success";
        returnValue: any;
    } | {
        kind: "failed";
        error: string;
    } | {
        kind: "canceled";
    };
    context: {
        assignmentId: import("convex/values").GenericId<"assignments">;
    };
}, Promise<null>>;
