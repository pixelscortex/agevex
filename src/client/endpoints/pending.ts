// Root-scoped UI decision projection through the host authorization contract.
import { asSchema } from "ai";
import { queryGeneric } from "convex/server";
import { DECISION_LIMITS, decisionBytes, type JsonSchema } from "../../shared/decisions.js";
import { v } from "convex/values";
import { pendingItem } from "../../component/turns/decision-reads.js";
import { ownedThread, type EndpointContext } from "./access.js";

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

      const calls = await ctx.runQuery(ep.component.turns["decision-reads"].pending, {
        assignmentId: row.assignmentId,
        subject: row.subject,
        ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
      });

      const result = calls.map((call) => {
        const tool = ep.managedAgents.get(call.agent)?.declaredTools[call.tool];
        const input = call.input as { question?: unknown; agevexAnswerSchema?: JsonSchema } | null;

        const form = call.tool === "ask_user" && call.kind === "ask";

        return {
          ...call,
          ...(form && input ? { input: { question: input.question } } : {}),
          editable:
            call.kind === "approval" &&
            !call.providerExecuted &&
            !!tool?.execute &&
            !!asSchema(tool.inputSchema).validate,
          ...(typeof input?.question === "string" ? { question: input.question } : {}),
          ...(form && input?.agevexAnswerSchema ? { schema: input.agevexAnswerSchema } : {}),
        };
      });

      if (
        decisionBytes(result) > DECISION_LIMITS.outputBytes ||
        result.some((item) => decisionBytes(item) > DECISION_LIMITS.itemBytes)
      )
        throw new Error("PENDING_OUTPUT_TOO_LARGE");

      return result;
    },
  });
}
