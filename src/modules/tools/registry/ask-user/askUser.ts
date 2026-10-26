/**
 * Deferred question tool installed into the host app through the registry.
 * Core records its pending native call and resumes only after the owner answers.
 * This item owns no state table and performs no tool effect.
 */
import { assertFormSchema, type JsonSchema } from "agevex";
import { tool } from "ai";
import { z } from "zod";

export const ASK_USER_LIMITS = { minChars: 1, questionChars: 2000 } as const;
export const questionInput = z.strictObject({
  question: z.string().trim().min(ASK_USER_LIMITS.minChars).max(ASK_USER_LIMITS.questionChars),
});

/** App-supplied form metadata stays server-owned; models supply only the question.
 * Root assignments may ask by default; children need Agent.askUser: true.
 * answer({ threadId, toolCallId, value }) validates JSON before saving/waking.
 */
export function createAskUserTool(options: { answerSchema?: JsonSchema } = {}) {
  if (options.answerSchema) assertFormSchema(options.answerSchema);

  return Object.assign(
    tool({
      description: "Ask the user a question and wait for their validated answer.",
      inputSchema: questionInput,
    }),
    { agevexAskUser: { answerSchema: options.answerSchema } },
  );
}
