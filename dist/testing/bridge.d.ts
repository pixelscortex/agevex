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
