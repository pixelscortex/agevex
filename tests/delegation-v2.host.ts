import { v } from "convex/values";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { mockModel } from "@convex-dev/agent";
import {
  makeFunctionReference,
  internalActionGeneric,
  type FunctionReference,
  type ApiFromModules,
  anyApi,
} from "convex/server";
import {
  Agent,
  registerAgent,
  type Registration,
  type CoordinateArgs,
  type CoordinateResult,
  type TurnArgs,
} from "../src/client/index.js";
import { scriptedModel } from "../src/test.js";
import { components } from "./fixture/api.js";

type ModelArgs = Parameters<ReturnType<typeof mockModel>["doStream"]>[0];
export const v2 = {
  calls: [] as { agent: string; args: ModelArgs }[],
  steps: {} as Record<
    string,
    (call: number, args: ModelArgs) => LanguageModelV4Content[] | Promise<LanguageModelV4Content[]>
  >,
};
export function reset() {
  v2.calls.length = 0;
  v2.steps = {};
}
export const call = (
  toolName: string,
  input: unknown,
  toolCallId = crypto.randomUUID(),
): LanguageModelV4Content => ({
  type: "tool-call",
  toolName,
  toolCallId,
  input: JSON.stringify(input),
});
export const delegate = (agent: string, extra: object = {}) =>
  call("agevex_delegate", { agent, task: "bounded task", ...extra });
export const text = (value: string): LanguageModelV4Content[] => [{ type: "text", text: value }];
function model(agent: string) {
  const result = mockModel();
  result.doStream = async (args) => {
    const index = v2.calls.filter((entry) => entry.agent === agent).length;
    v2.calls.push({ agent, args });
    const content = (await v2.steps[agent]?.(index, args)) ?? text(`${agent} result ${index}`);
    return scriptedModel([content]).doStream(args);
  };
  return result;
}
export const reviewer = new Agent(components.agent, {
  name: "Reviewer",
  languageModel: model("Reviewer"),
  subagents: [],
});
export const builder = new Agent(components.agent, {
  name: "Builder",
  languageModel: model("Builder"),
  subagents: [reviewer],
});
export const main = new Agent(components.agent, {
  name: "Main",
  languageModel: model("Main"),
  subagents: [builder, reviewer],
});
export const failBeforeClaim = internalActionGeneric({
  args: { assignmentId: v.string(), turnToken: v.string(), sliceId: v.optional(v.string()) },
  handler: async () => {
    throw new Error("pre-claim dispatch failure");
  },
});
export function registration(limits?: Registration["limits"], preclaimFailure = false) {
  return registerAgent(components.agevex, {
    agents: [main],
    limits,
    refs: {
      runTurn: () =>
        makeFunctionReference<"action", TurnArgs, null>(
          preclaimFailure ? "agents:failBeforeClaim" : "agents:runTurn",
        ) as unknown as FunctionReference<"action", "internal", TurnArgs, null>,
      coordinate: () =>
        makeFunctionReference<"mutation", CoordinateArgs, CoordinateResult>(
          "agents:coordinate",
        ) as unknown as FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult>,
    },
    authorize: async (ctx, scope) => {
      if (scope.operation === "delegate" || scope.operation === "deliver") {
        if (scope.subject !== "alice") throw new Error("FORBIDDEN");
        return { subject: scope.subject };
      }
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("FORBIDDEN");
      return { subject: identity.subject };
    },
    authorizeExecution: async (_ctx, scope) => {
      if (scope.subject !== "alice") throw new Error("FORBIDDEN");
    },
  });
}
const runtime = registration();
export const { open, send, cancel, respond, answer, messages, activity, delegations, runTree } =
  runtime.authorizedEndpoints();
export const { runTurn, coordinate } = runtime.internalFunctions();
export const v2api = anyApi as unknown as ApiFromModules<{
  agents: {
    open: typeof open;
    send: typeof send;
    cancel: typeof cancel;
    respond: typeof respond;
    answer: typeof answer;
    messages: typeof messages;
    activity: typeof activity;
    delegations: typeof delegations;
    runTree: typeof runTree;
    coordinate: typeof coordinate;
  };
}>;
