// Reserved factory metadata crosses the host/native save boundary by registration name.
import { asSchema } from "ai";
import { convexToJson } from "convex/values";
import { assertJson, assertFormSchema, validateAnswer, DECISION_LIMITS, } from "./decisions.js";
import { definedAskValue } from "./ask-values.js";
/** A tool's map key is app-owned; only the factory marker grants ask-user semantics. */
export function askUserMarker(tool) {
    return tool?.agevexAskUser;
}
/** Schemas travel out of band, never in model-visible tool-call input. */
export async function askUserTools(tools, save) {
    const prepared = Object.fromEntries(Object.entries(tools).flatMap(([name, tool]) => askUserMarker(tool) ? [[name, { calls: [] }]] : []));
    for (const { message } of save.messages) {
        if (message?.role !== "assistant" || !Array.isArray(message.content))
            continue;
        for (const call of message.content) {
            if (call.type !== "tool-call" ||
                call.providerExecuted ||
                !Object.prototype.hasOwnProperty.call(prepared, call.toolName))
                continue;
            prepared[call.toolName].calls.push({
                toolCallId: call.toolCallId,
                ...(await prepareAsk(tools[call.toolName], call.input)),
            });
        }
    }
    return prepared;
}
/** Validate raw native call bytes on the host, where Zod and host callbacks run.
 * Recheck transformed/defaulted output too: only bounded JSON may be persisted.
 * A bad model call or derived form is a normal tool denial, never a lost turn.
 */
async function prepareAsk(tool, input) {
    let validated;
    try {
        assertJson(input);
        const schema = askUserMarker(tool)?.inputSchema ?? asSchema(tool.inputSchema);
        const checked = schema.validate ? await schema.validate(input) : checkDefaultQuestion(input);
        if (!checked?.success)
            return { error: "INVALID_QUESTION" };
        validated = definedAskValue(checked.value);
        assertJson(validated);
        convexToJson(validated);
    }
    catch {
        return { error: "INVALID_QUESTION" };
    }
    try {
        const configured = askUserMarker(tool)?.answerSchema;
        const derived = typeof configured === "function"
            ? configured(JSON.parse(JSON.stringify(validated)))
            : configured;
        // Derivation is synchronous. A returned Promise is never awaited, so swallow
        // its eventual rejection (no unhandled rejection) and fail closed below.
        if (typeof derived?.then === "function") {
            derived.then(undefined, () => undefined);
            return { error: "INVALID_FORM_SCHEMA" };
        }
        const answerSchema = definedAskValue(derived);
        if (typeof configured === "function" || answerSchema !== undefined)
            assertFormSchema(answerSchema);
        if (answerSchema !== undefined)
            convexToJson(answerSchema);
        return { input: validated, ...(answerSchema !== undefined ? { answerSchema } : {}) };
    }
    catch {
        return { error: "INVALID_FORM_SCHEMA" };
    }
}
/** Old installed registry markers lack a parsed schema. Prefer the tool's own
 * validator above; if absent, enforce the original strict question contract.
 */
function checkDefaultQuestion(input) {
    validateAnswer(input, {
        type: "object",
        required: ["question"],
        additionalProperties: false,
        properties: {
            question: { type: "string", minLength: 1, maxLength: DECISION_LIMITS.questionChars },
        },
    });
    const question = input.question.trim();
    return { success: !!question, value: { question } };
}
