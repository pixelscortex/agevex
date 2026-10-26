/**
 * Deferred question tool installed into the host app through the registry.
 * Core records its pending native call and resumes only after the owner answers.
 * This item owns no state table and performs no tool effect.
 */
import { type JsonSchema } from "agevex";
import { z } from "zod";
export declare const ASK_USER_LIMITS: {
    readonly minChars: 1;
    readonly questionChars: 2000;
};
export declare const questionInput: z.ZodObject<{
    question: z.ZodString;
}, z.core.$strict>;
/** App-supplied form metadata stays server-owned; models supply only the question.
 * Root assignments may ask by default; children need Agent.askUser: true.
 * answer({ threadId, toolCallId, value }) validates JSON before saving/waking.
 */
export declare function createAskUserTool(options?: {
    answerSchema?: JsonSchema;
}): import("ai").Tool<{
    question: string;
}, never, import("@ai-sdk/provider-utils").Context> & {
    agevexAskUser: {
        answerSchema: JsonSchema | undefined;
    };
};
