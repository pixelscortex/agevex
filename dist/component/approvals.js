import { getConvexSize } from "convex/values";
import { LIMITS } from "./limits.js";
// Fixed-size references bound coordination metadata even for huge native ids.
export const callKey = (id) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
export function keyString(digest) {
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function approvalKey(id) {
    return keyString(await callKey(id));
}
/** Agent 0.7.7's exact native response protocol, without its history planner. */
export async function saveResponses(ctx, target, responses, deniedCalls = []) {
    const message = {
        role: "tool",
        content: [
            ...responses.map((response) => ({ type: "tool-approval-response", ...response })),
            ...deniedCalls.map((call) => ({
                type: "tool-result",
                ...call,
                output: { type: "execution-denied", reason: "cancelled" },
            })),
        ],
    };
    // Cleanup sends one response/result pair at a time. Reserve native envelope
    // space too, then check the actual returned document before committing.
    if (deniedCalls.length && getConvexSize(message) + 4096 > LIMITS.cleanupMessageBytes)
        throw new Error("CLEANUP_MESSAGE_TOO_LARGE");
    const saved = (await ctx.runMutation(target.addMessages, {
        threadId: target.threadId,
        agentName: target.agent,
        promptMessageId: target.messageId,
        failPendingSteps: false,
        messages: [{ message }],
    }));
    if (deniedCalls.length &&
        saved.messages.some((doc) => getConvexSize(doc) > LIMITS.cleanupMessageBytes))
        throw new Error("CLEANUP_MESSAGE_TOO_LARGE");
    return saved.messages[0]._id;
}
