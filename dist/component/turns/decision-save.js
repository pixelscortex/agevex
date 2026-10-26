import { DECISION_LIMITS, decisionBytes, assertFormSchema } from "../../shared/decisions.js";
/** Recheck persisted role before any ask_user deferral, including direct saves.
 * Factory schema is trusted host metadata, never a model-supplied form program.
 * The extra run read is fixed at <=16 KiB per native save, independent of calls.
 */
export async function prepareDecisions(ctx, row, args, tools = {}) {
    for (const metadata of Object.values(tools))
        if (metadata.answerSchema)
            assertFormSchema(metadata.answerSchema);
    const run = row.runId ? await ctx.db.get("runs", row.runId) : null;
    const allowed = run?.settings?.find((entry) => entry.agent === row.agent)?.settings.askUser ??
        !row.rootAssignmentId;
    for (const saved of args.messages) {
        if (saved.message?.role !== "assistant" || !Array.isArray(saved.message.content))
            continue;
        for (const part of saved.message.content) {
            if (part.type !== "tool-call" ||
                !Object.prototype.hasOwnProperty.call(tools, part.toolName) ||
                part.providerExecuted)
                continue;
            if (!allowed) {
                denyAsk(args, saved, part.toolCallId, part.toolName, "ROOT_ONLY");
                continue;
            }
            const input = part.input;
            if (!input ||
                typeof input.question !== "string" ||
                !input.question.trim() ||
                input.question.length > DECISION_LIMITS.questionChars ||
                Object.keys(input).some((key) => key !== "question")) {
                denyAsk(args, saved, part.toolCallId, part.toolName, "INVALID_QUESTION");
                continue;
            }
            // Form metadata is copied into the compact proposal, not native model input.
        }
    }
}
/** Normal tool result, with no approval request left to expose to a human.
 * Preserve AI SDK's own validation result when it already recorded one.
 */
function denyAsk(args, saved, toolCallId, toolName, code) {
    if (saved.message?.role === "assistant" && Array.isArray(saved.message.content))
        saved.message.content = saved.message.content.filter((part) => part.type !== "tool-approval-request" || part.toolCallId !== toolCallId);
    const resulted = args.messages.some((doc) => doc.message?.role === "tool" &&
        doc.message.content.some((part) => part.type === "tool-result" && part.toolCallId === toolCallId));
    if (!resulted)
        args.messages.push({
            message: {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        toolCallId,
                        toolName,
                        output: { type: "json", value: { status: "denied", code } },
                    },
                ],
            },
        });
}
/** Only pending input is bounded. Reasoning/text stays in native Agent storage.
 * The caller commits APPROVAL_LIMIT before native save rather than rolling back
 * a paid model step with an untyped generation failure.
 */
export function oversizedDecisionInput(messages, deferred) {
    return messages.some(({ message }) => {
        if (message?.role !== "assistant" || !Array.isArray(message.content))
            return false;
        const approvals = new Set(message.content.flatMap((part) => part.type === "tool-approval-request" ? [part.toolCallId] : []));
        return message.content.some((part) => part.type === "tool-call" &&
            (approvals.has(part.toolCallId) || deferred.has(part.toolName)) &&
            decisionBytes(part.input) > DECISION_LIMITS.valueBytes);
    });
}
