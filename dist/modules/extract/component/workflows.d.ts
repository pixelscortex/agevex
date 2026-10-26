/**
 * Id-only extraction Workflow and its one-shot completion callback.
 * Admission starts the worker without retries; completion drains fenced host callbacks.
 * Payloads never enter the journal, and callback failures cannot cancel other callbacks.
 */
import { WorkflowManager } from "@convex-dev/workflow";
export declare const manager: WorkflowManager;
/** Run the exact admitted worker once, retaining the versioned id-only journal step. */
export declare const extract: import("convex/server").RegisteredMutation<"internal", import("@convex-dev/workflow").WorkflowArgs<{
    artifactId: import("convex/values").VString<string, "required">;
    attempt: import("convex/values").VFloat64<number, "required">;
    claim: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    subject: import("convex/values").VString<string | undefined, "optional">;
    worker: import("convex/values").VString<string, "required">;
    version: import("convex/values").VFloat64<number, "required">;
}>, import("@convex-dev/workflow").WorkflowMutationResult<null>>;
/** Drain the owning claim callbacks atomically and clean up the completed Workflow. */
export declare const done: import("convex/server").RegisteredMutation<"internal", {
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
        claim: string;
        attempt: number;
        artifactId: string;
    };
}, Promise<null>>;
