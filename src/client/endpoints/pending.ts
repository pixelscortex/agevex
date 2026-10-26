// Root-scoped UI decision projection through the host authorization contract.
import { editableApproval } from "../once.js";
import { asSchema } from "ai";
import { queryGeneric } from "convex/server";
import { DECISION_LIMITS, decisionBytes } from "../../shared/decisions.js";
import { ConvexError, v } from "convex/values";
import { pendingItem } from "../../component/turns/decision_reads.js";
import { ownedThread, type EndpointContext } from "./access.js";
import { askProjection } from "../../shared/ask-values.js";

/** One reactive query includes the owned root and its current live children. */
export function pendingApprovalsEndpoint(ep: EndpointContext) {
  return queryGeneric({
    args: { threadId: v.string(), rootRunId: v.optional(v.string()) },
    returns: v.array(
      v.object({
        ...pendingItem.fields,
        editable: v.boolean(),
        schema: v.optional(v.any()),
        question: v.optional(v.string()),
      }),
    ),
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "pendingApprovals");

      const calls = await ctx.runQuery(ep.component.turns.decision_reads.pending, {
        assignmentId: row.assignmentId,
        subject: row.subject,
        ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
      });

      const result = calls.map((call) => {
        const tool = ep.managedAgents.get(call.agent)?.declaredTools[call.tool];
        const form = call.kind === "ask";

        // A large item must not hide other decisions. Check before copying question
        // or schema into the public projection, which can duplicate input bytes.
        if (call.truncated || decisionBytes(call) > DECISION_LIMITS.itemBytes)
          return {
            ...call,
            input: null,
            schema: undefined,
            truncated: true as const,
            editable: false,
          };

        const item = {
          ...call,
          ...(form ? askProjection(call.input) : {}),
          editable:
            call.kind === "approval" &&
            !call.providerExecuted &&
            !!tool?.execute &&
            editableApproval(tool) &&
            !!asSchema(tool.inputSchema).validate,
          ...(form && call.schema ? { schema: call.schema } : {}),
        };

        return decisionBytes(item) <= DECISION_LIMITS.itemBytes - DECISION_LIMITS.arrayEnvelopeBytes
          ? item
          : { ...call, input: null, schema: undefined, truncated: true as const, editable: false };
      });

      if (
        decisionBytes(result) > DECISION_LIMITS.outputBytes ||
        result.some((item) => decisionBytes(item) > DECISION_LIMITS.itemBytes)
      )
        throw new ConvexError({ code: "PENDING_OUTPUT_TOO_LARGE" });

      return result;
    },
  });
}
