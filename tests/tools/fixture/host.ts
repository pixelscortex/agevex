import { mockModel } from "@convex-dev/agent";
import type { ComponentApi as NativeApi } from "@convex-dev/agent/_generated/component.js";
import type { LanguageModelV4Content, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  Agent,
  registerAgent,
  type CoordinateArgs,
  type CoordinateResult,
  type TurnArgs,
} from "agevex";
import type { ComponentApi } from "../../../src/component/_generated/component.js";
import {
  componentsGeneric,
  makeFunctionReference,
  anyApi,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  type ApiFromModules,
  type FunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { scriptedModel } from "../../../src/test.js";
import { createTodoTools, type TodoFunctions } from "../../../docs/site/registry/todo/todo.js";
import { createGoalTools, type GoalFunctions } from "../../../docs/site/registry/goals/goals.js";
import { createAskUserTool } from "../../../docs/site/registry/ask-user/askUser.js";
import {
  createContinueBudgetTool,
  resumeAfterBudgetStop,
} from "../../../docs/site/registry/continue-budget/continueBudget.js";

export const state = {
  steps: [] as LanguageModelV4Content[][],
  calls: [] as LanguageModelV4CallOptions[],
  /** Fake metering: slices checked so far and the run id each check saw. */
  budget: { checks: 0, runIds: [] as string[] },
};
const model = mockModel();
model.doStream = async (args) => {
  const index = state.calls.length;
  state.calls.push(args);
  return scriptedModel([state.steps[index] ?? [{ type: "text", text: "Finished." }]]).doStream(
    args,
  );
};
const component = componentsGeneric().agevex as unknown as ComponentApi;
const agent = componentsGeneric().agent as unknown as NativeApi;
const hostApi = anyApi as unknown as ApiFromModules<{
  todoState: typeof import("../../../docs/site/registry/todo/todoState.js");
  goalsState: typeof import("../../../docs/site/registry/goals/goalsState.js");
}>;
export const todoRefs = hostApi.todoState satisfies TodoFunctions;
export const goalRefs = hostApi.goalsState satisfies GoalFunctions;

const main = new Agent(agent, {
  name: "Tools",
  subagents: [],
  languageModel: model,
  tools: {
    ...createTodoTools(todoRefs),
    ...createGoalTools(goalRefs),
    ask_user: createAskUserTool(),
    continue_budget: createContinueBudgetTool(),
  },
});
const runtime = registerAgent(component, {
  agents: [main],
  refs: {
    runTurn: () =>
      makeFunctionReference<"action", TurnArgs, null>(
        "host:runTurn",
      ) as unknown as FunctionReference<"action", "internal", TurnArgs, null>,
    coordinate: () =>
      makeFunctionReference<"mutation", CoordinateArgs, CoordinateResult>(
        "host:coordinate",
      ) as unknown as FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult>,
  },
  authorize: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    return { subject: identity.subject };
  },
  budget: {
    // Allowed while the slices used so far stay within the subject's stored
    // limit (no row means unlimited). The limit is a host database row.
    check: async (ctx, { subject, runId }) => {
      state.budget.checks++;
      state.budget.runIds.push(runId);
      const limit = await ctx.runQuery(budgetLimitRef, { subject });
      return { allowed: limit === null || state.budget.checks <= limit };
    },
  },
  authorizeExecution: async (_ctx, { subject }) => {
    if (subject !== "alice" && subject !== "bob") throw new Error("REVOKED");
  },
});

const budgetLimitRef = makeFunctionReference<"query", { subject: string }, number | null>(
  "host:budgetLimit",
) as unknown as FunctionReference<"query", "internal", { subject: string }, number | null>;
export const budgetLimit = internalQueryGeneric({
  args: { subject: v.string() },
  handler: async (ctx, { subject }) =>
    (
      await ctx.db
        .query("budgets")
        .withIndex("by_subject", (q) => q.eq("subject", subject))
        .unique()
    )?.limit ?? null,
});
export const setBudgetLimit = internalMutationGeneric({
  args: { subject: v.string(), limit: v.number() },
  handler: async (ctx, { subject, limit }) => {
    const row = await ctx.db
      .query("budgets")
      .withIndex("by_subject", (q) => q.eq("subject", subject))
      .unique();
    if (row) await ctx.db.patch("budgets", row._id, { limit });
    else await ctx.db.insert("budgets", { subject, limit });
  },
});

/**
 * The host's one-mutation resume. Every step goes through ctx.runQuery /
 * ctx.runMutation of core's authorized endpoints, so all of it shares this
 * mutation's transaction and the caller's identity.
 */
// Untyped on purpose: typing this module's own API from itself would be circular.
const selfApi = anyApi;
export const resumeAfterBudget = mutationGeneric({
  args: {
    threadId: v.string(),
    approvalId: v.string(),
    instruction: v.optional(v.string()),
  },
  handler: async (ctx, { threadId, approvalId, instruction }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    return resumeAfterBudgetStop({
      threadId,
      approvalId,
      instruction,
      // Replaying the owner's own recorded response is idempotent in core and
      // returns the saved response message; its exact id is then read directly.
      isApproved: async (args) => {
        const { messageId } = await ctx.runMutation(selfApi.host.respond, {
          ...args,
          approved: true,
        });
        const [saved] = await ctx.runQuery(agent.messages.getMessagesByIds, {
          messageIds: [messageId],
        });
        const parts = saved?.message?.content;
        return (
          Array.isArray(parts) &&
          parts.some(
            (part) =>
              part.type === "tool-approval-response" &&
              part.approvalId === args.approvalId &&
              part.approved === true,
          )
        );
      },
      activity: async () => {
        const stopped = await ctx.runQuery(selfApi.host.activity, { threadId });
        const row = await ctx.runQuery(component.queue.execution, {
          assignmentId: stopped.assignmentId,
        });
        return { errorCode: stopped.errorCode, runId: row?.runId ?? null };
      },
      raiseBudget: () =>
        ctx.runMutation(selfApi.host.setBudgetLimit, {
          subject: identity.subject,
          limit: state.budget.checks + 1,
        }),
      cancel: () => ctx.runMutation(selfApi.host.cancel, { threadId }),
      send: (args) => ctx.runMutation(selfApi.host.send, { threadId, ...args }),
    });
  },
});

export const { runTurn, coordinate } = runtime.internalFunctions();
export const { open, send, respond, answer, cancel, messages, activity } =
  runtime.authorizedEndpoints();
