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
  type ApiFromModules,
  type FunctionReference,
} from "convex/server";
import { scriptedModel } from "../../../src/test.js";
import { createTodoTools, type TodoFunctions } from "../../../docs/site/registry/todo/todo.js";
import { createGoalTools, type GoalFunctions } from "../../../docs/site/registry/goals/goals.js";
import { createAskUserTool } from "../../../docs/site/registry/ask-user/askUser.js";
import { createContinueBudgetTool } from "../../../docs/site/registry/continue-budget/continueBudget.js";

export const state = {
  steps: [] as LanguageModelV4Content[][],
  calls: [] as LanguageModelV4CallOptions[],
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
  authorizeExecution: async (_ctx, { subject }) => {
    if (subject !== "alice" && subject !== "bob") throw new Error("REVOKED");
  },
});

export const { runTurn, coordinate } = runtime.internalFunctions();
export const { open, send, respond, cancel, messages, activity } = runtime.authorizedEndpoints();
