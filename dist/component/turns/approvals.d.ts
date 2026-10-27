/** Approval responses MUST go through the authorized respond endpoint. A
 * response saved directly through Agent is not seen by this runtime.
 * See `respondToApproval`.
 */
export declare const respond: import("convex/server").RegisteredMutation<"public", {
    effectiveInput?: any;
    subject: string;
    addMessages: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    approvalId: string;
    decision: {
        reason?: string | undefined;
        kind: "reject";
    } | {
        edit?: {
            input: any;
        } | undefined;
        kind: "approve";
    };
}, Promise<{
    messageId: string;
    replayed: boolean;
}>>;
/** Save a deferred native result and release its continuation atomically.
 * See `answerDeferredCall` for the read budget. */
export declare const answer: import("convex/server").RegisteredMutation<"public", {
    value: any;
    subject: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    toolCallId: string;
}, Promise<{
    messageId: string;
    replayed: boolean;
}>>;
