import type { CoordinatorCtx, RuntimeContext } from "../registration/context.js";
/** The native facts one child-result verification is allowed to assume. */
export type ChildResultTarget = {
    threadId: string;
    agentName: string;
    messageId: string;
    subject: string;
};
/**
 * Authenticate one child's final message against the native child transcript.
 *
 * Requires the thread to exist and still belong to the stored subject, and the
 * exact stored message id to be an `assistant` `success` message attributed to
 * the expected child agent and carry non-empty text. A caller-selected message id
 * therefore cannot settle or be delivered as a result, a tool-only or empty
 * completion is rejected, and a foreign thread is refused even when it holds a
 * message with the same id.
 *
 * The `assistant` role is what makes this a result and not merely a saved
 * message: native `saveMessage` lets a caller store a `user` message that names
 * an agent, so a user-role message on the correct child thread would otherwise
 * pass every other check and settle a run with no final assistant output. Native
 * user prompts are still stored and read normally; only result verification
 * requires the assistant role.
 *
 * Returns the verified text, or `null` when the message cannot be trusted.
 */
export declare function verifyChildMessage(rt: RuntimeContext, ctx: CoordinatorCtx, target: ChildResultTarget): Promise<string | null>;
