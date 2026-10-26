// Compact proposals share the receipts table but live exactly as long as their pause refs.
import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server.js";
import { approvalKey } from "../approvals.js";
import { DECISION_LIMITS, decisionBytes } from "../../shared/decisions.js";
import type { PreparedAskUser } from "../../shared/tool-markers.js";

export const proposal = v.object({
  id: v.string(),
  toolCallId: v.string(),
  tool: v.string(),
  input: v.any(),
  providerExecuted: v.boolean(),
  schema: v.optional(v.any()),
  truncated: v.optional(v.literal(true)),
});

/** Audit annotation for an approved call, read at execution as its effective input. */
export const approvedInput = v.object({
  edited: v.boolean(),
  toolCallId: v.string(),
  input: v.any(),
  originalHash: v.string(),
  effectiveHash: v.string(),
});

/** The stored row: the immutable proposal plus, once approved, the input to run.
 * It lives and dies with the pause reference (no TTL), so an approved call stays
 * executable while a sibling is undecided for longer than the receipt retention.
 */
export const storedProposal = v.object({
  ...proposal.fields,
  approved: v.optional(approvedInput),
});

/** Bound the copied proposal, never the containing native reasoning/text message.
 * At most 16*32 KiB extra writes per save; every proposal fits well below 1 MiB.
 * Huge native identifiers still support cancellation through the exact native
 * ref; their pending stub uses a fixed-size hash rather than copying megabytes.
 */
export async function saveProposal(
  ctx: MutationCtx,
  call: { toolCallId: string; toolName: string; input?: unknown; providerExecuted?: boolean },
  id: string,
  metadata?: PreparedAskUser,
) {
  const checked = metadata?.calls.find((entry) => entry.toolCallId === call.toolCallId);

  const result = {
    id,
    toolCallId: call.toolCallId,
    tool: call.toolName,
    input: checked ? checked.input : (call.input ?? null),
    providerExecuted: !!call.providerExecuted,
    ...(checked?.answerSchema ? { schema: checked.answerSchema } : {}),
  };

  if (
    decisionBytes(result) <=
      DECISION_LIMITS.proposalBytes - DECISION_LIMITS.proposalEnvelopeBytes &&
    decisionBytes(result.input) <= DECISION_LIMITS.valueBytes &&
    [id, call.toolCallId, call.toolName].every(
      (value) => value.length <= DECISION_LIMITS.identifierChars,
    )
  )
    return ctx.db.insert("receipts", { kind: "proposal", result });

  const bounded = async (value: string) =>
    value.length > DECISION_LIMITS.identifierChars ? approvalKey(value) : value;

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
