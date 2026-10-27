/** Scripted host for deferred asks, approval editing and child policy. */
import { mockModel } from "@convex-dev/agent";
import type { ComponentApi as NativeApi } from "@convex-dev/agent/_generated/component.js";
import type { LanguageModelV4Content, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  Agent,
  defineOnceTool,
  registerAgent,
  type ManagedAgent,
  type CoordinateArgs,
  type CoordinateResult,
  type TurnArgs,
} from "agevex";
import type { ComponentApi } from "../../../src/component/_generated/component.js";
import { componentsGeneric, makeFunctionReference, type FunctionReference } from "convex/server";
import { z } from "zod";
import { scriptedModel } from "../../../src/test.js";
import { createAskUserTool } from "../../../src/modules/tools/client/ask_user.js";

export const state = {
  effects: [] as string[],
  hookInputs: [] as unknown[],
  rewrite: false as boolean | "mutate" | "block",
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

/** Separate scripted child proves ask ownership and delegation policy. */
export const child = {
  calls: [] as LanguageModelV4CallOptions[],
  steps: null as LanguageModelV4Content[][] | null,
  askUser: undefined as boolean | undefined,
};
const childModel = mockModel();

childModel.doStream = async (args) => {
  const index = child.calls.length;

  child.calls.push(args);

  return scriptedModel([
    child.steps?.[index] ?? [{ type: "text", text: "Child finished." }],
  ]).doStream(args);
};

export const helper = new Agent(agent, {
  name: "Helper",
  subagents: [],
  languageModel: childModel,
  tools: { ask_user: createAskUserTool() },
});

Object.defineProperty(helper, "askUser", { get: () => child.askUser });

export const main = new Agent(agent, {
  name: "Tools",
  subagents: [helper],
  hooks: {
    beforeTool: (_hc, { tool, input }) => {
      if (tool !== "editable_echo") return;

      state.hookInputs.push(input);

      if (state.rewrite === "block") return { block: "refused" };

      if (state.rewrite === "mutate") {
        (input as { text: string }).text = "mutated";

        return;
      }

      return state.rewrite ? { input: { text: "hook rewrite" } } : undefined;
    },
  },
  languageModel: model,
  tools: {
    editable_echo: defineOnceTool({
      name: "editable_echo",
      input: z.strictObject({ text: z.string().min(1) }),
      approval: { editable: true },
      run: ({ text }) => {
        state.effects.push(text);

        return text;
      },
    }),
    ask_user: createAskUserTool(),
  },
});

function createRuntime() {
  return registerAgent(component, {
    title: false,
    agents: [main as ManagedAgent, helper as ManagedAgent],
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
    authorize: async (ctx, scope) => {
      // Delegation runs from a background slice with no end user on the connection.
      if (scope.operation === "delegate" || scope.operation === "deliver") {
        if (scope.subject !== "alice" && scope.subject !== "bob") throw new Error("FORBIDDEN");

        return { subject: scope.subject };
      }

      const identity = await ctx.auth.getUserIdentity();

      if (!identity) throw new Error("UNAUTHENTICATED");

      return { subject: identity.subject };
    },
    authorizeExecution: async (_ctx, { subject }) => {
      if (subject !== "alice" && subject !== "bob") throw new Error("REVOKED");
    },
  });
}

const runtime = createRuntime();

export const { runTurn, coordinate } = runtime.internalFunctions();
export const {
  open,
  send,
  respond,
  answer,
  pendingApprovals,
  cancel,
  messages,
  activity,
  delegations,
} = runtime.authorizedEndpoints();

/** Rebuild registration when a fixture changes per-agent interaction policy. */
export function fixtureExports() {
  const current = createRuntime();

  return { ...current.internalFunctions(), ...current.authorizedEndpoints() };
}
