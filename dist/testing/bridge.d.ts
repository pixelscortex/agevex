/** Existing delegation protocol tests inspect stored states (asking/completed),
 * distinct from the new public asleep/done projection. Never shipped in core.
 */
export declare const delegationState: import("convex/server").RegisteredQuery<"internal", {
    threadId: string;
}, Promise<{
    runId: import("convex/values").GenericId<"subagentRuns">;
    parentAssignmentId: import("convex/values").GenericId<"assignments">;
    childAssignmentId: import("convex/values").GenericId<"assignments"> | null;
    agent: string;
    status: "failed" | "running" | "completed" | "queued" | "asking";
    depth: number;
    childThreadId: string | null;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
}[]>>;
/** Forward one query to `components[lane][module][name]` of this component. */
export declare const read: import("convex/server").RegisteredQuery<"internal", {
    name: string;
    args: any;
    lane: string;
    module: string;
}, Promise<any>>;
/** Forward one mutation to `components[lane][module][name]` of this component. */
export declare const write: import("convex/server").RegisteredMutation<"internal", {
    name: string;
    args: any;
    lane: string;
    module: string;
}, Promise<any>>;
/** Observe scheduler activity in this component, including completed checks. */
export declare const recoveryJobs: import("convex/server").RegisteredQuery<"internal", {}, Promise<{
    total: number;
    pending: number;
}>>;
/** Inspect the bounded regression fixture after cancellation commits. */
export declare const queuedWork: import("convex/server").RegisteredQuery<"internal", {}, Promise<{
    inbox: any[];
    runs: any[];
}>>;
/** Bounded inspection for the ledger purge margin regression. */
export declare const receiptCount: import("convex/server").RegisteredQuery<"internal", {}, Promise<number>>;
/** White-box tests read the whole coordination row; turns.slices.execution returns
 * only the projection the runtime reads. */
export declare const assignment: import("convex/server").RegisteredQuery<"internal", {
    assignmentId: string;
}, Promise<any>>;
/** Inspect the exact child result recorded on one run, without native history. */
export declare const childResultMessageId: import("convex/server").RegisteredQuery<"internal", {
    runId: string;
}, Promise<any>>;
/** Populate the F1 coordination envelope for the all-maxima cancellation
 * fixture. Bodies remain in Agent; cancellation must only touch this metadata. */
export declare const fillHookMetadata: import("convex/server").RegisteredMutation<"internal", {
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
/** Exact run and claim-armed watchdog metadata for offline settings fixtures. */
export declare const runMetadata: import("convex/server").RegisteredQuery<"internal", {
    assignmentId: string;
}, Promise<{
    run: any;
    watchdog: {
        _id: import("convex/values").GenericId<"_scheduled_functions">;
        _creationTime: number;
        completedTime?: number | undefined;
        name: string;
        args: any[];
        scheduledTime: number;
        state: {
            kind: "pending";
        } | {
            kind: "inProgress";
        } | {
            kind: "success";
        } | {
            kind: "failed";
            error: string;
        } | {
            kind: "canceled";
        };
    } | {
        _id: import("convex/values").GenericId<"_storage">;
        _creationTime: number;
        contentType?: string | undefined;
        sha256: string;
        size: number;
    } | null;
}>>;
/** Fill the <=168-run cancellation fixture with maximum-size accepted settings.
 * Read+patch <=168*16 KiB twice (<6 MiB), no messages or transcript scans. */
export declare const fillRunSettings: import("convex/server").RegisteredMutation<"internal", {
    settings?: {
        agent: string;
        settings: {
            askUser?: boolean | undefined;
            mode: "stream" | "generate";
            maxOutputTokens: number;
            modelTimeoutMs: number;
            toolTimeoutMs: number;
            stepsPerTurn: number;
        };
    }[] | undefined;
}, Promise<null>>;
