import {
  Agent,
  registerAgent,
  defineOnceTool,
  type AgentHooks,
  type SideAgent,
  type Registration,
  type TurnArgs,
  type CoordinateArgs,
  type CoordinateResult,
  type ToolContext,
} from "../src/client/index.js";
import { mockModel, createTool, type ContextHandler } from "@convex-dev/agent";
import {
  mutationGeneric,
  makeFunctionReference,
  anyApi,
  type FunctionReference,
  type ApiFromModules,
} from "convex/server";
import { v } from "convex/values";
import { tool } from "ai";
import { z } from "zod";
import { scriptedModel } from "../src/test.js";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { components } from "./fixture/api.js";

type Args = Parameters<ReturnType<typeof mockModel>["doStream"]>[0];
export const fixture = {
  slots: {} as Pick<Registration, "usage" | "budget" | "telemetry" | "sandbox" | "extract">,
  sandbox: false,
  supportsUrls: true,
  toolContext: undefined as ToolContext | undefined,
  toolWork: undefined as undefined | ((tc: ToolContext) => Promise<unknown>),
  hooks: {} as AgentHooks,
  builderHooks: {} as AgentHooks,
  sides: [] as SideAgent[],
  calls: [] as { agent: string; args: Args }[],
  effects: [] as string[],
  approval: false,
  authorizeExecution: undefined as Registration["authorizeExecution"] | undefined,
  contextHandler: undefined as ContextHandler | undefined,
  steps: {} as Record<
    string,
    (n: number, args: Args) => LanguageModelV4Content[] | Promise<LanguageModelV4Content[]>
  >,
};
export const text = (value: string): LanguageModelV4Content[] => [{ type: "text", text: value }];
export const call = (name: string, input: unknown): LanguageModelV4Content[] => [
  {
    type: "tool-call",
    toolName: name,
    toolCallId: crypto.randomUUID(),
    input: JSON.stringify(input),
  },
];
function model(name: string) {
  const model = mockModel();

  // This fake provider accepts storage URLs as native file parts. The SDK
  // therefore never downloads test storage or touches the network.
  Object.defineProperty(model, "supportedUrls", {
    get: () =>
      fixture.supportsUrls ? { "*": [/^https:\/\/some-deployment\.convex\.cloud\//] } : {},
  });

  model.doStream = async (args) => {
    const n = fixture.calls.filter((call) => call.agent === name).length;

    fixture.calls.push({ agent: name, args });

    return scriptedModel([
      (await fixture.steps[name]?.(n, args)) ?? text(`${name} answer ${n}`),
    ]).doStream(args);
  };

  return model;
}
export const critic = new Agent(components.agent, {
  name: "Critic",
  languageModel: model("Critic"),
});
export const builder = new Agent(components.agent, {
  name: "Builder",
  languageModel: model("Builder"),
  subagents: [critic],
  sideAgents: [{ agent: critic, every: { turns: 1 }, sees: "delta" }],
});

const echo = {
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }: { text: string }) => {
    fixture.effects.push(text);

    return text;
  },
};

export const main = new Agent(components.agent, {
  name: "Main",
  languageModel: model("Main"),
  contextHandler: (ctx, context) => fixture.contextHandler?.(ctx, context) ?? context.allMessages,
  subagents: [builder],
  tools: {
    managed: tool({
      inputSchema: z.object({}),
      execute: async (_input, options) => {
        const tc = options.context as ToolContext;

        fixture.toolContext = tc;

        return (await fixture.toolWork?.(tc)) ?? "done";
      },
    }),
    metered_once: defineOnceTool({
      name: "metered_once",
      input: z.object({}),
      run: async (_input, tc) => {
        fixture.toolContext = tc;

        return ((await fixture.toolWork?.(tc)) as string) ?? "done";
      },
    }),
    echo: tool({ ...echo, needsApproval: () => fixture.approval }),
    native: createTool({
      ...echo,
      execute: async (ctx, input) => {
        if (!ctx.runMutation) throw new Error("MISSING_NATIVE_CONTEXT");

        return echo.execute(input);
      },
    }),
    once: defineOnceTool({
      name: "effect",
      description: "Echo text exactly once.",
      input: z.object({ text: z.string() }),
      run: (input) => echo.execute(input),
    }),
  },
});
Object.defineProperty(builder, "hooks", { get: () => fixture.builderHooks });
Object.defineProperty(main, "sandbox", { get: () => fixture.sandbox });
Object.defineProperty(main, "hooks", { get: () => fixture.hooks });
Object.defineProperty(main, "sideAgents", { get: () => fixture.sides });
export function reset() {
  fixture.slots = {};
  fixture.sandbox = false;
  fixture.supportsUrls = true;
  fixture.toolContext = undefined;
  fixture.toolWork = undefined;
  fixture.hooks = {};
  fixture.builderHooks = {};
  fixture.sides = [];
  fixture.calls = [];
  fixture.effects = [];
  fixture.approval = false;
  fixture.authorizeExecution = undefined;
  fixture.contextHandler = undefined;
  fixture.steps = {};
}
export function registration(limits?: Registration["limits"]) {
  return registerAgent(components.agevex, {
    agents: [main],
    ...fixture.slots,
    limits,
    modelAllowlist: ["routed"],
    models: () => model("Routed"),
    refs: {
      runTurn: () =>
        makeFunctionReference<"action", TurnArgs, null>(
          "agents:runTurn",
        ) as unknown as FunctionReference<"action", "internal", TurnArgs, null>,
      coordinate: () =>
        makeFunctionReference<"mutation", CoordinateArgs, CoordinateResult>(
          "agents:coordinate",
        ) as unknown as FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult>,
    },
    authorize: async (ctx, scope) => {
      if (
        scope.operation === "delegate" ||
        scope.operation === "deliver" ||
        scope.operation === "sandbox"
      ) {
        if (scope.subject !== "alice") throw new Error("FORBIDDEN");

        return { subject: scope.subject };
      }

      const user = await ctx.auth.getUserIdentity();

      if (!user) throw new Error("FORBIDDEN");

      return { subject: user.subject };
    },
    authorizeExecution: async (ctx, scope) => {
      if (scope.subject !== "alice") throw new Error("FORBIDDEN");

      await fixture.authorizeExecution?.(ctx, scope);
    },
  });
}
export function exports(limits?: Registration["limits"]) {
  const runtime = registration(limits);

  return {
    ...runtime.internalFunctions(),
    ...runtime.authorizedEndpoints(),
    note: mutationGeneric({
      args: { threadId: v.string(), text: v.string(), from: v.string() },
      handler: async (ctx, args: { threadId: string; text: string; from: string }) =>
        runtime.note(ctx, args),
    }),
  };
}
export const api = anyApi as unknown as ApiFromModules<{ agents: ReturnType<typeof exports> }>;
