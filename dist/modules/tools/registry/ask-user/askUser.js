/**
 * Deferred question tool installed into the host app through the registry.
 * Core records its pending native call and resumes only after the owner answers.
 * This item owns no state table and performs no tool effect.
 */
import { assertFormSchema, validateAnswer } from "agevex";
import { asSchema, jsonSchema, tool } from "ai";
import { z } from "zod";
import { ConvexError } from "convex/values";
export const ASK_USER_LIMITS = { minChars: 1, questionChars: 2000 };
export const questionInput = z.strictObject({
    question: z.string().trim().min(ASK_USER_LIMITS.minChars).max(ASK_USER_LIMITS.questionChars),
});
/** App-supplied form metadata stays server-owned; models supply the validated input.
 * Root assignments may ask by default; children need Agent.askUser: true.
 * answer({ threadId, toolCallId, value }) validates JSON before saving/waking.
 */
export function createAskUserTool(options = {}) {
    if (options.answerSchema?.constructor.name === "AsyncFunction")
        throw new Error("answerSchema must be synchronous; async callbacks are not supported");
    if (options.answerSchema && typeof options.answerSchema !== "function")
        assertFormSchema(options.answerSchema);
    const inputSchema = options.inputSchema ?? questionInput;
    const schema = asSchema("_zod" in inputSchema ? inputSchema : formInputSchema(inputSchema));
    return Object.assign(tool({
        description: "Ask the user a question and wait for their validated answer.",
        inputSchema: unparsedSchema(schema),
    }), { agevexAskUser: { inputSchema: schema, answerSchema: options.answerSchema } });
}
/** AI SDK 7 to-response-messages.ts:89-95 saves parsed call input. Preserve the
 * original JSON here so host-side validation never parses a transformed value
 * twice (for example, a string transformed into a number or a renamed field).
 * The host stores the validated output and derives its form at the save fence.
 */
function unparsedSchema(schema) {
    return jsonSchema(() => schema.jsonSchema, {
        validate: async (value) => {
            const checked = await schema.validate(value);
            return checked.success ? { success: true, value } : checked;
        },
    });
}
/** Raw JSON schemas use the same closed dialect as forms: no ignored constraints.
 * AI SDK's jsonSchema alone advertises a schema but does not validate calls.
 */
function formInputSchema(schema) {
    if (schema.type !== "object")
        throw new ConvexError({ code: "INVALID_FORM_SCHEMA" });
    schema = { ...schema, additionalProperties: schema.additionalProperties ?? false };
    assertFormSchema(schema);
    return jsonSchema(schema, {
        validate: (value) => {
            try {
                validateAnswer(value, schema);
                return { success: true, value };
            }
            catch (error) {
                return { success: false, error: error };
            }
        },
    });
}
