import type { Doc } from "../_generated/dataModel.js";
/** The thread's public status, including its delegation counts. */
export declare function activityView(row: Doc<"assignments">): {
    assignmentId: import("convex/values").GenericId<"assignments">;
    threadId: string;
    agent: string;
    assignmentStatus: "open";
    turnStatus: "idle" | "running" | "queued" | "recovery_required";
    queuedMessages: number;
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
    runId: import("convex/values").GenericId<"runs"> | undefined;
    subagents: {
        active: number;
        history: number;
        total: number;
    };
};
/** The assignment's scope plus whether it is a public root. */
export declare function assignmentScope(row: Doc<"assignments">, threadId: string): {
    assignmentId: import("convex/values").GenericId<"assignments">;
    threadId: string;
    subject: string;
    agent: string;
    root: boolean;
};
/** Validator of `executionView`; each field names its reader. */
export declare const vExecution: import("convex/values").VObject<{
    modelStep?: {
        messageId: string;
        stepOrder: number;
    } | undefined;
    turnToken?: string | undefined;
    attachmentBytes: number;
    agent: string;
    turnStatus: "idle" | "running" | "queued" | "recovery_required";
    runTurn: string;
    cancellationEpoch: number;
    cancelled: boolean;
    approvalBlocked: boolean;
}, {
    agent: import("convex/values").VString<string, "required">;
    runTurn: import("convex/values").VString<string, "required">;
    turnStatus: import("convex/values").VUnion<"idle" | "running" | "queued" | "recovery_required", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"idle", "required">, import("convex/values").VLiteral<"recovery_required", "required">], "required", never>;
    turnToken: import("convex/values").VString<string | undefined, "optional">;
    cancellationEpoch: import("convex/values").VFloat64<number, "required">;
    cancelled: import("convex/values").VBoolean<boolean, "required">;
    approvalBlocked: import("convex/values").VBoolean<boolean, "required">;
    modelStep: import("convex/values").VObject<{
        messageId: string;
        stepOrder: number;
    } | undefined, {
        messageId: import("convex/values").VString<string, "required">;
        stepOrder: import("convex/values").VFloat64<number, "required">;
    }, "optional", "messageId" | "stepOrder">;
    attachmentBytes: import("convex/values").VFloat64<number, "required">;
}, "required", "attachmentBytes" | "agent" | "turnStatus" | "modelStep" | "runTurn" | "cancellationEpoch" | "cancelled" | "turnToken" | "approvalBlocked" | "modelStep.messageId" | "modelStep.stepOrder">;
/** Read execution metadata outside the Workflow journal; only ids cross steps.
 * The host polls this during generation, so it returns only the fields its
 * readers use (workflows/worker.ts dispatch; in src/client/turn/, runTurn's
 * fence checks, cancel poll, usage capture and download bound), never the
 * context refs, approvals or recovery state of the whole row. */
export declare function executionView(row: Doc<"assignments">): {
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
};
