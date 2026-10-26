import { mockModel } from "@convex-dev/agent";
import {
  actionGeneric,
  anyApi,
  componentsGeneric,
  makeFunctionReference,
  type ApiFromModules,
  type FunctionReference,
} from "convex/server";
import { v } from "convex/values";
import type { AgentComponent } from "@convex-dev/agent";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import {
  Agent,
  registerAgent,
  type CoordinateArgs,
  type CoordinateResult,
} from "../../src/client/index.js";
import type { TurnArgs } from "../../src/client/index.js";
import type { ComponentApi as CoreApi } from "../../src/component/_generated/component.js";
import { scriptedModel } from "../../src/test.js";
import { defineSandbox, sandboxCompletion } from "../../src/sandbox/index.js";
import type { ComponentApi as SandboxApi } from "../../src/sandbox/component/_generated/component.js";
import type { SandboxLimits } from "../../src/sandbox/limits.js";
import type { PollArgs, PollActionArgs, SettleArgs } from "../../src/sandbox/types.js";
import { fakeSandboxProvider } from "../../src/testing/sandbox.js";

// A real host wiring of the sandbox module into agevex through its slot, with
// only the model and the provider faked: this is the code the docs page shows.
const components = componentsGeneric() as unknown as {
  agent: AgentComponent;
  agevex: CoreApi;
  sandbox: SandboxApi;
};

type Args = Parameters<ReturnType<typeof mockModel>["doStream"]>[0];
type Step = (n: number, args: Args) => LanguageModelV4Content[] | Promise<LanguageModelV4Content[]>;

export const fixture = {
  scope: "thread" as "thread" | "run" | "subject",
  limits: { pollMinMs: 100, pollMaxMs: 400 } as Partial<SandboxLimits>,
  fake: fakeSandboxProvider(),
  calls: [] as { agent: string; args: Args }[],
  steps: {} as Record<string, Step>,
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
export function reset(fake = fakeSandboxProvider(), scope: typeof fixture.scope = "thread") {
  fixture.scope = scope;
  fixture.fake = fake;
  fixture.limits = { pollMinMs: 100, pollMaxMs: 400 };
  fixture.calls = [];
  fixture.steps = {};
  current = undefined;
}

function model(name: string) {
  const model = mockModel();

  model.doStream = async (args) => {
    const n = fixture.calls.filter((entry) => entry.agent === name).length;

    fixture.calls.push({ agent: name, args });

    return scriptedModel([
      (await fixture.steps[name]?.(n, args)) ?? text(`${name} answer ${n}`),
    ]).doStream(args);
  };

  return model;
}

const builder = new Agent(components.agent, {
  name: "Builder",
  languageModel: model("Builder"),
  sandbox: true,
});

const main = new Agent(components.agent, {
  name: "Main",
  languageModel: model("Main"),
  subagents: [builder],
  sandbox: true,
});

// A root that has NOT opted in: only its delegated child has.
const lead = new Agent(components.agent, {
  name: "Lead",
  languageModel: model("Lead"),
  subagents: [builder],
});

// No `sandbox: true`: the slot is registered, but this agent must not see it.
const plain = new Agent(components.agent, { name: "Plain", languageModel: model("Plain") });

const hostRef = <Type extends "action" | "mutation", Args extends Record<string, unknown>, Out>(
  name: string,
) =>
  makeFunctionReference<Type, Args, Out>(`agents:${name}`) as unknown as FunctionReference<
    Type,
    "internal",
    Args,
    Out
  >;

const people = ["alice", "bob"];

/** The wiring a host writes; `current` lets tests reach the sandbox and runtime. */
function build() {
  // eslint-disable-next-line prefer-const -- the sandbox's thunk reads it lazily
  let runtime: ReturnType<typeof registerAgent>;

  const sandbox = defineSandbox({
    component: components.sandbox,
    provider: fixture.fake.provider,
    scope: fixture.scope,
    limits: fixture.limits,
    agent: components.agent,
    refs: {
      wake: () => hostRef<"mutation", PollArgs, null>("wake"),
      poll: () => hostRef<"action", PollActionArgs, null>("poll"),
      settle: () => hostRef<"mutation", SettleArgs, null>("settle"),
      cleanup: () => hostRef<"action", Record<string, never>, null>("cleanup"),
    },
    authorize: async (ctx, request) => {
      // Exports are the one public path: the principal is the caller. Tool,
      // poll and cleanup calls run without a user and carry trusted facts.
      if (request.operation === "export") {
        const user = await ctx.auth.getUserIdentity();

        if (!user) throw new Error("FORBIDDEN");

        return { subject: user.subject };
      }

      if (request.subject !== undefined && !people.includes(request.subject))
        throw new Error("FORBIDDEN");

      return { subject: request.subject ?? "system" };
    },
    onComplete: sandboxCompletion(() => runtime),
  });

  runtime = registerAgent(components.agevex, {
    agents: [main, plain, lead],
    sandbox: sandbox.slot(),
    refs: {
      runTurn: () => hostRef<"action", TurnArgs, null>("runTurn"),
      coordinate: () => hostRef<"mutation", CoordinateArgs, CoordinateResult>("coordinate"),
    },
    authorize: async (ctx, scope) => {
      if (
        scope.operation === "delegate" ||
        scope.operation === "deliver" ||
        scope.operation === "sandbox"
      ) {
        if (!people.includes(scope.subject)) throw new Error("FORBIDDEN");

        return { subject: scope.subject };
      }

      const user = await ctx.auth.getUserIdentity();

      if (!user) throw new Error("FORBIDDEN");

      return { subject: user.subject };
    },
    authorizeExecution: async (_ctx, scope) => {
      if (!people.includes(scope.subject)) throw new Error("FORBIDDEN");
    },
  });

  return { sandbox, runtime };
}
let current: ReturnType<typeof build> | undefined;

export const wiring = () => (current ??= build());

export function exports() {
  const { sandbox, runtime } = wiring();
  const functions = sandbox.internalFunctions();

  return {
    ...runtime.internalFunctions(),
    ...runtime.authorizedEndpoints(),
    wake: functions.wake,
    poll: functions.poll,
    settle: functions.settle,
    cleanup: functions.cleanup,
    exportFile: actionGeneric({
      args: { threadId: v.string(), path: v.string() },
      handler: (ctx, args) => sandbox.export(ctx, args),
    }),
  };
}
export const api = anyApi as unknown as ApiFromModules<{ agents: ReturnType<typeof exports> }>;
