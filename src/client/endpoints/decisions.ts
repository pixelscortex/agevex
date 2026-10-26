// Server-owned tool resolution and schema validation for human decisions.
import { asSchema, type Tool } from "ai";
import { ConvexError } from "convex/values";
import type { GenericDataModel, GenericMutationCtx } from "convex/server";
import { assertJson, type Decision } from "../../shared/decisions.js";
import type { EndpointContext } from "./access.js";

/** Resolve by the recorded call's name. An unregistered/provider tool cannot be edited.
 * Validation and component response share the host mutation's transaction, so invalid
 * edits never create a receipt, annotation, native response or wake.
 */
export async function effectiveInput(
  ep: EndpointContext,
  ctx: GenericMutationCtx<GenericDataModel>,
  row: { assignmentId: string; subject: string; native: { declaredTools: Record<string, Tool> } },
  approvalId: string,
  decision: Decision,
) {
  if (decision.kind === "reject") {
    if (decision.reason !== undefined) assertJson(decision.reason);

    return {};
  }

  const call = await ctx.runQuery(ep.component.turns["decision-reads"].detail, {
    assignmentId: row.assignmentId,
    subject: row.subject,
    id: approvalId,
    deferred: false,
  });

  if (!call) return {}; // The response ledger decides replay/conflict before pending lookup.

  const tool = row.native.declaredTools[call.tool];

  if (call.providerExecuted || !tool?.execute) {
    if (decision.edit) throw new ConvexError({ code: "APPROVAL_NOT_EDITABLE" });

    return {};
  }

  const input = decision.edit ? decision.edit.input : call.input;

  assertJson(input);
  const schema = asSchema(tool.inputSchema);

  if (!schema.validate) {
    if (decision.edit) throw new ConvexError({ code: "APPROVAL_NOT_EDITABLE" });

    return {};
  }

  const checked = await schema.validate(input);

  if (!checked.success) throw new ConvexError({ code: "INVALID_TOOL_INPUT" });

  // Schema transforms/defaults must be the exact bytes subsequently fingerprinted.
  assertJson(checked.value);

  return { effectiveInput: checked.value };
}
