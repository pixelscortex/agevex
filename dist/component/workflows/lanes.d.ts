/** Independent root/child Workflow lanes own execution, event waits and
 * bounded journal rotation. Paid actions never retry. Workpool reports killed
 * steps through normal failure completion, with its upstream recovery latency.
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
 * The default slice bound is implicit; explicit overrides travel with the loop.
 */
export declare function startLoop(ctx: MutationCtx, row: Doc<"assignments">, child: boolean): Promise<WorkflowId>;
/** Every created event is awaited, including the final iteration before
 * rotation. After delivery, queue admission is checked again under ownership.
 */
export declare function defineLoop(manager: WorkflowManager, child: boolean, inline?: boolean): import("convex/server").RegisteredMutation<"internal", import("@convex-dev/workflow").WorkflowArgs<{
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    version: import("convex/values").VFloat64<number, "required">;
    slicesPerTurn: import("convex/values").VFloat64<number | undefined, "optional">;
}>, import("@convex-dev/workflow").WorkflowMutationResult<{
    executionId: string;
    epoch: number;
} | null>>;
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
}>, import("@convex-dev/workflow").WorkflowMutationResult<{
    executionId: string;
    epoch: number;
} | null>>;
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
        epoch: number;
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
}>, import("@convex-dev/workflow").WorkflowMutationResult<{
    executionId: string;
    epoch: number;
} | null>>;
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
        epoch: number;
        assignmentId: import("convex/values").GenericId<"assignments">;
    };
}, Promise<null>>;
