/**
 * Deferred question tool exported directly to the host app.
 * Core records its pending native call and resumes only after the owner answers.
 * This item owns no state table and performs no tool effect.
 */
import { type JsonSchema } from "../../../client/index.js";
import { type Schema } from "ai";
import { z } from "zod";
export declare const ASK_USER_LIMITS: {
    readonly minChars: 1;
    readonly questionChars: 2000;
};
export declare const questionInput: z.ZodObject<{
    question: z.ZodString;
}, z.core.$strict>;
export type AskUserOptions<Input = z.output<typeof questionInput>> = {
    inputSchema?: z.ZodType<Input> | JsonSchema;
    answerSchema?: JsonSchema | ((input: Input) => JsonSchema);
};
/** App-supplied form metadata stays server-owned; models supply the validated input.
 * Root assignments may ask by default; children need Agent.askUser: true.
 * answer({ threadId, toolCallId, value }) validates JSON before saving/waking.
 */
export declare function createAskUserTool<Input = z.output<typeof questionInput>>(options?: AskUserOptions<Input>): import("ai").Tool<unknown, never, import("@ai-sdk/provider-utils").Context> & {
    agevexAskUser: {
        inputSchema: Schema<unknown>;
        answerSchema: JsonSchema | ((input: Input) => JsonSchema) | undefined;
    };
};
