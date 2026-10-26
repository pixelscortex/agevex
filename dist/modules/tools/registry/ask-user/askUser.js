/**
 * Deferred question tool installed into the host app through the registry.
 * Core records its pending native call and resumes only after the owner answers.
 * This item owns no state table and performs no tool effect.
 */
import { tool } from "ai";
import { z } from "zod";
export const ASK_USER_LIMITS = { minChars: 1, questionChars: 2000 };
export const questionInput = z.strictObject({
    question: z.string().trim().min(ASK_USER_LIMITS.minChars).max(ASK_USER_LIMITS.questionChars),
});
/**
 * A deferred tool: it has no `execute`, so the model's call is recorded by core
 * as a pending native tool call and the turn ends idle until a human answers.
 * The owner answers through the core endpoint
 * `answer({ threadId, toolCallId, text })`; core authorizes the owner, saves the
 * text as the native tool result and resumes the turn once every pending call on
 * the thread is answered. The model sees the text verbatim as the tool result.
 *
 * Why no `defineOnceTool`: there is no effect to run, so there is nothing for
 * the receipts ledger to deduplicate. Core's `answer` is itself idempotent per
 * `toolCallId` (same text replays the original result; different text is a
 * typed KEY_CONFLICT) and refuses foreign, unrecorded or already answered calls.
 *
 * Bounds: the question is validated by AI SDK before the call is recorded
 * (blank or oversized input becomes an ordinary tool error and never pauses the
 * thread). The answer is bounded by core: non-empty, at most 16,000 UTF-16 units
 * (`LIMITS.messageLength`). Deferred calls share core's 16-call pause bound
 * (`LIMITS.approvalsPerPause`) with approvals.
 */
export function createAskUserTool() {
    return tool({
        description: "Ask the user one question and wait for their free-text answer, which is returned as this tool's result.",
        inputSchema: questionInput,
    });
}
