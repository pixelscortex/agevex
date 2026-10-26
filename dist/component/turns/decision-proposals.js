// Compact proposals share the receipts table but live exactly as long as their pause refs.
import { v } from "convex/values";
import { approvalKey } from "../approvals.js";
import { DECISION_LIMITS, decisionBytes } from "../../shared/decisions.js";
export const proposal = v.object({
    id: v.string(),
    toolCallId: v.string(),
    tool: v.string(),
    input: v.any(),
    providerExecuted: v.boolean(),
    schema: v.optional(v.any()),
    truncated: v.optional(v.literal(true)),
});
/** Bound the copied proposal, never the containing native reasoning/text message.
 * At most 16*32 KiB extra writes per save; every proposal fits well below 1 MiB.
 * Huge native identifiers still support cancellation through the exact native
 * ref; their pending stub uses a fixed-size hash rather than copying megabytes.
 */
export async function saveProposal(ctx, call, id, metadata) {
    const result = {
        id,
        toolCallId: call.toolCallId,
        tool: call.toolName,
        input: call.input ?? null,
        providerExecuted: !!call.providerExecuted,
        ...(metadata?.answerSchema ? { schema: metadata.answerSchema } : {}),
    };
    if (decisionBytes(result) <=
        DECISION_LIMITS.proposalBytes - DECISION_LIMITS.proposalEnvelopeBytes &&
        decisionBytes(call.input ?? null) <= DECISION_LIMITS.valueBytes &&
        [id, call.toolCallId, call.toolName].every((value) => value.length <= DECISION_LIMITS.identifierChars))
        return ctx.db.insert("receipts", { kind: "proposal", result });
    const bounded = async (value) => value.length > DECISION_LIMITS.identifierChars ? approvalKey(value) : value;
    return ctx.db.insert("receipts", {
        kind: "proposal",
        result: {
            id: await bounded(id),
            toolCallId: await bounded(call.toolCallId),
            tool: await bounded(call.toolName),
            input: null,
            providerExecuted: !!call.providerExecuted,
            truncated: true,
        },
    });
}
