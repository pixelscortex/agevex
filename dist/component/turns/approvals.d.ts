import { type MutationCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
/** `replayed` is true when an identical retry was served from the response
 * receipt, so a host can tell a first decision from a replay (e.g. to record
 * single-use consent only once). */
export declare const vResponseResult: import("convex/values").VObject<{
    messageId: string;
    replayed: boolean;
}, {
    messageId: import("convex/values").VString<string, "required">;
    replayed: import("convex/values").VBoolean<boolean, "required">;
}, "required", "messageId" | "replayed">;
/** Approval responses MUST go through the authorized respond endpoint. A
 * response saved directly through Agent is not seen by this runtime.
 * Saves the native approval response, marks the request resolved, and once
 * every request is resolved releases the pause into its continuation turn. */
export declare function respondToApproval(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    subject: string;
    approvalId: string;
    approved: boolean;
    reason?: string;
    addMessages: string;
}): Promise<{
    messageId: string;
    replayed: boolean;
}>;
/** Save a deferred native result and release its continuation atomically.
 * One exact <=1 MiB call + native prompt <=1 MiB + six <=1 MiB merge
 * heads (Agent messages.ts:436-477) + <=64 KiB saved result + <4.75 MiB
 * bounded indexed readiness/group-release/wake metadata (releaseGroups):
 * <13 MiB <16 MiB. Approval/deferred counts never multiply native reads.
 * At most 16 fixed-size references are reindexed per answer.
 * No tool payload is copied into coordination state, even for large inputs.
 */
export declare function answerDeferredCall(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    subject: string;
    toolCallId: string;
    text: string;
}): Promise<{
    messageId: string;
    replayed: boolean;
}>;
/** Approval responses MUST go through the authorized respond endpoint. A
 * response saved directly through Agent is not seen by this runtime.
 * See `respondToApproval`.
 */
export declare const respond: import("convex/server").RegisteredMutation<"public", {
    reason?: string | undefined;
    assignmentId: import("convex/values").GenericId<"assignments">;
    subject: string;
    addMessages: string;
    approvalId: string;
    approved: boolean;
}, Promise<{
    messageId: string;
    replayed: boolean;
}>>;
/** Save a deferred native result and release its continuation atomically.
 * See `answerDeferredCall` for the read budget. */
export declare const answer: import("convex/server").RegisteredMutation<"public", {
    text: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    subject: string;
    toolCallId: string;
}, Promise<{
    messageId: string;
    replayed: boolean;
}>>;
