/**
 * Claim one model slice, not an entire retriable action. A first slice consumes
 * the reserved inbox row, while subsequent slices require both continuation
 * state and a new slice id under the same execution token. Replayed or racing
 * calls therefore cannot pay for the same slice twice. Each slice arms its own
 * watchdog; lane wait and time between completed slices do not spend it. Consecutive child results
 * share a final prompt anchor, letting native context include the whole batch.
 * See turns/claim.ts.
 */
export declare const claim: import("convex/server").RegisteredMutation<"public", {
    notes?: {
        getMessages: string;
        addMessages: string;
        updateMessage: string;
    } | undefined;
    sliceId?: string | undefined;
    agentIndex?: number | undefined;
    routeModel?: boolean | undefined;
    assignmentId: import("convex/values").GenericId<"assignments">;
    turnToken: string;
}, Promise<{
    modelId?: string | undefined;
    agent: string;
    settings: {
        mode: "stream" | "generate";
        maxOutputTokens: number;
        modelTimeoutMs: number;
        toolTimeoutMs: number;
        stepsPerTurn: number;
    };
    assignmentId: string;
    threadId: string;
    runId: string;
    subject: string;
    turn: number;
    cancellationEpoch: number;
    promptMessageId: string;
    turnOrigin: "user" | "subagent_result";
    isTurnStart: boolean;
    isRunStart: boolean;
    subagent: {
        agent: string;
        runId: string;
        subject: string;
        childThreadId: string;
        rootAssignmentId: string;
        actorAgent: string;
        deliveryToken: string;
        rootAgent: string;
        rootThreadId: string;
    } | null;
} | null>>;
/** End the running turn, successfully or with a failure code; see
 * turns/finish.ts. */
export declare const finish: import("convex/server").RegisteredMutation<"public", {
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
    assignmentId: import("convex/values").GenericId<"assignments">;
    turnToken: string;
}, Promise<null>>;
/** Execution metadata the host action polls; see turns/views.ts. */
export declare const execution: import("convex/server").RegisteredQuery<"public", {
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    agent: string;
    runTurn: string;
    turnStatus: "idle" | "running" | "queued" | "recovery_required";
    turnToken: string | undefined;
    cancellationEpoch: number;
    cancelled: boolean;
    approvalBlocked: boolean;
    modelStep: {
        messageId: string;
        stepOrder: number;
    } | undefined;
    attachmentBytes: number;
} | null>>;
/** A single transactional fence around the native mutation, including its save.
 * Checking in the action before calling a native mutation leaves a cancel race;
 * nested Convex mutations share this transaction, so cancellation wins or the
 * write commits before cancellation. Host tool mutations use this same path.
 * See turns/write.ts.
 */
export declare const write: import("convex/server").RegisteredMutation<"public", {
    rejectStale?: boolean | undefined;
    nativeStream?: string | undefined;
    trackUsage?: boolean | undefined;
    deferredTools?: string[] | undefined;
    nativeMessages?: {
        getMessages: string;
        finalizeMessage: string;
    } | undefined;
    args: any;
    handle: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    executionId: string;
    cancellationEpoch: number;
}, Promise<unknown>>;
/** The host action finished one slice and will run another; see
 * turns/boundaries.ts. */
export declare const continueTurn: import("convex/server").RegisteredMutation<"public", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    messageId: string;
    executionId: string;
    cancellationEpoch: number;
}, Promise<null>>;
/** Phase 1c's seam: all between-slice state checks belong in this mutation.
 * Returns the token to run another slice, or null to end the turn workflow. */
export declare const betweenSlices: import("convex/server").RegisteredMutation<"internal", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    executionId: string;
}, Promise<string | null>>;
/** The turn workflow ran out of slices: finish the turn with SLICE_LIMIT. */
export declare const sliceLimit: import("convex/server").RegisteredMutation<"internal", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    executionId: string;
}, Promise<null>>;
/** Sticky evidence failure on the captured run, even after cancellation/later sends.
 * One run row <=16 KiB read/written, never changes execution or paid receipts. */
export declare const usageFailed: import("convex/server").RegisteredMutation<"public", {
    runId: import("convex/values").GenericId<"runs">;
}, Promise<null>>;
/** Host projections compose this sticky marker with the optional usage view. */
export declare const usageReporting: import("convex/server").RegisteredQuery<"public", {
    runId: import("convex/values").GenericId<"runs">;
}, Promise<boolean>>;
