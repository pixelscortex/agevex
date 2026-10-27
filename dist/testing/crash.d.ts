/** Fail a real in-flight paid step via Workpool, including scheduler cancellation.
 * Offline tests invoke upstream recovery directly; the real local probe waits
 * for its unmodified cadence instead. Neither route calls agevex finalization.
 */
export declare const interrupt: import("convex/server").RegisteredMutation<"internal", {
    mode: "failed" | "canceled" | "scheduler";
}, Promise<number>>;
