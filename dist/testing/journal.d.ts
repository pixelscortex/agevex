export declare const REPLAY_BOUNDARY = "AGEVEX_JOURNAL_REPLAY_BOUNDARY";
/** Every workflow (oldest first) with its journal steps in step order. */
export declare const turns: import("convex/server").RegisteredQuery<"internal", {}, Promise<{
    id: string;
    args: {
        assignmentId: string;
        executionId?: string;
        version: number;
    };
    kind: string;
    steps: Record<string, unknown>[];
}[]>>;
/**
 * Clone one workflow's journal into a fresh workflow and start its replay.
 * The in-progress step becomes a recorded sentinel failure (`REPLAY_BOUNDARY`).
 */
export declare const clone: import("convex/server").RegisteredMutation<"internal", {
    workflowId: import("convex/values").GenericId<"workflows">;
}, Promise<import("convex/values").GenericId<"workflows">>>;
/** The run result of a (cloned) workflow, or null while it has none. */
export declare const result: import("convex/server").RegisteredQuery<"internal", {
    workflowId: import("convex/values").GenericId<"workflows">;
}, Promise<any>>;
/** Fault injection drops only unconsumed doorbells, never accepted inbox rows. */
export declare const dropPings: import("convex/server").RegisteredMutation<"internal", {
    workflowId: import("convex/values").GenericId<"workflows">;
}, Promise<null>>;
/** Count orphaned events using the real nested Workflow store. */
export declare const events: import("convex/server").RegisteredQuery<"internal", {}, Promise<{
    orphaned: number;
    total: number;
}>>;
