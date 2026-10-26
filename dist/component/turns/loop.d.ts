/** The loop workflow's step: the queued turn's token, or null to sleep. */
export declare const next: import("convex/server").RegisteredMutation<"internal", {
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<string | null>>;
/** The scheduled recovery check; see `reconcileDoorbell` in turns/wake.ts. */
export declare const reconcile: import("convex/server").RegisteredMutation<"internal", {
    recoveryAt?: number | undefined;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
