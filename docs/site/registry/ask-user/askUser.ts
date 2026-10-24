import { defineOnceTool } from "agevex";
import { z } from "zod";

export const ASK_USER_LIMITS = { minChars: 1, questionChars: 2000 } as const;
export const questionInput = z.strictObject({
  question: z.string().trim().min(ASK_USER_LIMITS.minChars).max(ASK_USER_LIMITS.questionChars),
});

/**
 * Agent 0.7.7 persists the native approval request/response. The host answers
 * with core respond({ threadId, approvalId, approved, reason }). This is a
 * yes/no question: AI SDK filters approved reasons from the model prompt
 * (ai/src/prompt/convert-to-language-model-prompt.ts:339-341). Send freeform
 * answers through core send as well. Never scan messages to recover them.
 * Do not save a native response directly: core must wake the waiting turn.
 * Source: @convex-dev/agent/src/approvals.ts:3-7,65-82.
 */
export function createAskUserTool() {
  const approval = defineOnceTool({
    name: "ask_user",
    input: questionInput,
    run: (input, tc) => {
      tc.signal.throwIfAborted();
      // Only approved calls execute. The answer remains on the native
      // approval-response part; never echo model text as a human answer.
      return { approved: true, question: questionInput.parse(input).question };
    },
  });
  approval.description =
    "Ask the user one yes/no question and wait for native approval. Freeform answers require a separate user message.";
  approval.needsApproval = true;
  return approval;
}
