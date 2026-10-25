import { createOpenAI } from "@ai-sdk/openai";
import { componentsGeneric, makeFunctionReference, type FunctionReference } from "convex/server";
import type { ComponentApi as NativeComponent } from "@convex-dev/agent/_generated/component.js";
import type { ComponentApi } from "../../../src/component/_generated/component.js";
import {
  Agent,
  registerAgent,
  type TurnArgs,
  type CoordinateArgs,
  type CoordinateResult,
} from "../../../src/client/index.js";

import { LIVE_LIMITS } from "../config.js";

declare const process: { env: Record<string, string | undefined> };
export const live = {
  delegation: false,
  depth: false,
  builderCalls: 0,
  reviewerCalls: 0,
  rootCalls: 0,
  childCalls: 0,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
  costReported: false,
  models: new Set<string>(),
  evidence: [] as Promise<void>[],
};
export const modelId = process.env.OPENROUTER_LIVE_MODEL ?? "openrouter/free";
const maxUsd = Number(process.env.OPENROUTER_LIVE_MAX_USD ?? LIVE_LIMITS.maxUsd);
const provider = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY ?? "skipped",
  baseURL: "https://openrouter.ai/api/v1",
  name: "openrouter",
  fetch: async (url, init) => {
    if (++live.requests > LIVE_LIMITS.requests || live.usd >= maxUsd)
      throw new Error("LIVE_COST_CAP");
    const response = await fetch(url, init);
    // Read a clone for the provider's authoritative routed model and cost.
    // Never log request headers or a provider error body containing credentials.
    const evidence = response
      .clone()
      .text()
      .then((body) => {
        for (const line of body.split("\n")) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const chunk = JSON.parse(line.slice(6)) as {
              model?: string;
              usage?: { cost?: number };
            };
            if (chunk.model) live.models.add(chunk.model);
            if (typeof chunk.usage?.cost === "number") {
              live.costReported = true;
              live.usd += chunk.usage.cost;
            }
          } catch {
            /* Keep SSE comments and non-JSON keepalives out of evidence. */
          }
        }
      });
    live.evidence.push(evidence);
    return response;
  },
});
const native = componentsGeneric().agent as unknown as NativeComponent<"agent">;
const agevex = componentsGeneric().agevex as unknown as ComponentApi<"agevex">;
const rootModel = provider.chat(modelId);
const rootStream = rootModel.doStream.bind(rootModel);
rootModel.doStream = (args) => {
  const call = live.rootCalls++;
  // Force exactly two real tool invocations in the collaboration scenario.
  // Choosing a tool is host policy supported by the native model interface;
  // the runtime still validates, creates, runs and verifies every child.
  return rootStream({
    ...args,
    maxOutputTokens: LIVE_LIMITS.outputTokens,
    // Both child agents are registered on Main. Constrain this scenario's
    // model-facing choice so repeated delegation cannot accidentally choose
    // Builder and add an unrelated Reviewer run to its two-child assertion.
    tools: args.tools?.map((tool) =>
      tool.type === "function" && tool.name === "agevex_delegate"
        ? {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: {
                ...tool.inputSchema.properties,
                agent: { type: "string", enum: [live.depth ? "Builder" : "Researcher"] },
              },
            },
          }
        : tool,
    ),
    // A forced tool choice still permits multiple calls in one response.
    // OpenAI chat 4.0.102 src/chat/openai-chat-language-model.ts:116-120,205
    // reads the openai namespace even with name="openrouter" and forwards
    // this native option as parallel_tool_calls. Keep each scripted launch
    // to one child so provider batching cannot invalidate the scenario count.
    providerOptions: {
      ...args.providerOptions,
      openai: { ...args.providerOptions?.openai, parallelToolCalls: false },
    },
    toolChoice:
      (live.depth && call === 0) || (live.delegation && call < 2)
        ? { type: "tool", toolName: "agevex_delegate" }
        : { type: "none" },
  });
};
const childModel = provider.chat(modelId);
const childStream = childModel.doStream.bind(childModel);
childModel.doStream = (args) => {
  live.childCalls++;
  return childStream({ ...args, maxOutputTokens: LIVE_LIMITS.outputTokens });
};
const usageHandler = (
  _ctx: unknown,
  { usage }: { usage: { inputTokens?: number; outputTokens?: number } },
) => {
  live.inputTokens += usage.inputTokens ?? 0;
  live.outputTokens += usage.outputTokens ?? 0;
};
const child = new Agent(native, {
  name: "Researcher",
  languageModel: childModel,
  subagents: [],
  instructions: "Answer the task in one short sentence. Do not call tools.",
  usageHandler,
});
const reviewerModel = provider.chat(modelId);
const reviewerStream = reviewerModel.doStream.bind(reviewerModel);
reviewerModel.doStream = (args) => {
  live.reviewerCalls++;
  return reviewerStream({
    ...args,
    maxOutputTokens: LIVE_LIMITS.outputTokens,
    toolChoice: { type: "none" },
  });
};
const reviewer = new Agent(native, {
  name: "Reviewer",
  languageModel: reviewerModel,
  subagents: [],
  usageHandler,
  instructions: "Review the task in one short sentence. Do not call tools.",
});
const builderModel = provider.chat(modelId);
const builderStream = builderModel.doStream.bind(builderModel);
builderModel.doStream = (args) => {
  const call = live.builderCalls++;
  return builderStream({
    ...args,
    maxOutputTokens: LIVE_LIMITS.outputTokens,
    providerOptions: {
      ...args.providerOptions,
      openai: { ...args.providerOptions?.openai, parallelToolCalls: false },
    },
    toolChoice: call === 0 ? { type: "tool", toolName: "agevex_delegate" } : { type: "none" },
  });
};
const builder = new Agent(native, {
  name: "Builder",
  languageModel: builderModel,
  subagents: [reviewer],
  usageHandler,
  instructions:
    "First delegate one very short task to Reviewer. When its result arrives, reply in one short sentence. Never delegate to any other agent.",
});
const main = new Agent(native, {
  name: "Main",
  languageModel: rootModel,
  subagents: [child, builder],
  instructions:
    "For a depth-two task delegate exactly once to Builder, then give a short final answer after its result. For other tasks use Researcher when required to delegate. Use a very short factual task. After the second Researcher result, reply in one short sentence. Never delegate to any other agent.",
  usageHandler,
});
const runtime = registerAgent(agevex, {
  agents: [main],
  modelAllowlist: [modelId],
  models: () => rootModel,
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
    if (scope.operation === "delegate" || scope.operation === "deliver") {
      if (scope.subject !== "live-owner") throw new Error("FORBIDDEN");
      return { subject: scope.subject };
    }
    const user = await ctx.auth.getUserIdentity();
    if (user?.subject !== "live-owner") throw new Error("FORBIDDEN");
    return { subject: user.subject };
  },
  authorizeExecution: async (_ctx, scope) => {
    if (scope.subject !== "live-owner") throw new Error("FORBIDDEN");
  },
});
export const { runTurn, coordinate } = runtime.internalFunctions();
export const { open, send, cancel, messages, streams, activity, delegations, runTree } =
  runtime.authorizedEndpoints();
