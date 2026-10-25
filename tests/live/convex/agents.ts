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
  type AgentHooks,
  type SlotFacts,
  type MeterChargeBackend,
  type UsageSlot,
} from "../../../src/client/index.js";

import { LIVE_LIMITS } from "../config.js";

declare const process: { env: Record<string, string | undefined> };
export const live = {
  delegation: false,
  depth: false,
  builderCalls: 0,
  reviewerCalls: 0,
  criticCalls: 0,
  rootCalls: 0,
  childCalls: 0,
  charges: [] as { facts: SlotFacts; provider: string; key: string; usage?: unknown }[],
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
  costReported: false,
  models: new Set<string>(),
  responses: [] as {
    status: number;
    tools: string[];
    finishReasons: string[];
    errorCode?: string | number;
    errorMessage?: string;
  }[],
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
    // OpenRouter's native routing contract supports require_parameters
    // (ai-sdk-provider 3.0.0 src/types/openrouter-chat-settings.ts:196). A random
    // free route must support forced tool choice; silently dropping it makes
    // a fixed delegation scenario unreliable. No free endpoint currently
    // advertises parallel_tool_calls, so bound batching with host hooks below.
    const body = JSON.parse(String(init?.body));
    const response = await fetch(url, {
      ...init,
      body: JSON.stringify({ ...body, provider: { ...body.provider, require_parameters: true } }),
    });
    const outcome: (typeof live.responses)[number] = {
      status: response.status,
      tools: [] as string[],
      finishReasons: [] as string[],
    };
    live.responses.push(outcome);
    // Read a clone for the provider's authoritative routed model and cost.
    // Never log request headers or a provider error body containing credentials.
    const evidence = response
      .clone()
      .text()
      .then((body) => {
        for (const line of body.trim().startsWith("{") ? [`data: ${body}`] : body.split("\n")) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const chunk = JSON.parse(line.slice(6)) as {
              error?: { code?: string | number; message?: string };
              model?: string;
              usage?: { cost?: number };
              choices?: {
                finish_reason?: string;
                delta?: { tool_calls?: { function?: { name?: string } }[] };
              }[];
            };
            // Keep only small response metadata, never headers, provider error
            // bodies, generated text or tool arguments that could hold secrets.
            for (const choice of chunk.choices ?? []) {
              if (choice.finish_reason && outcome.finishReasons.length < LIVE_LIMITS.requests)
                outcome.finishReasons.push(choice.finish_reason);
              for (const tool of choice.delta?.tool_calls ?? [])
                if (tool.function?.name && outcome.tools.length < LIVE_LIMITS.requests)
                  outcome.tools.push(tool.function.name);
            }
            if (response.status >= 400 && chunk.error) {
              outcome.errorCode = chunk.error.code;
              outcome.errorMessage = chunk.error.message
                ?.replaceAll(process.env.OPENROUTER_API_KEY ?? "skipped", "[REDACTED]")
                .slice(0, 500);
            }
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
export const taskModel = provider.chat(modelId);
const handle = (key: string): MeterChargeBackend => ({
  key,
  attach: async () => {},
  correct: async () => {},
  settle: async () => {},
  get: async () => null,
});
export const fakeUsage: UsageSlot = {
  scope: (_ctx, facts) => ({
    estimate: async (_provider, args) => handle(args.key),
    record: async (provider, args) => {
      live.charges.push({ facts, provider, key: args.key, usage: args.usage });
      return handle(args.key);
    },
  }),
};
const native = componentsGeneric().agent as unknown as NativeComponent<"agent">;
const agevex = componentsGeneric().agevex as unknown as ComponentApi<"agevex">;
const rootModel = provider.chat(modelId);
const rootStream = rootModel.doStream.bind(rootModel);
rootModel.doStream = (args) => {
  const call = live.rootCalls++;
  const delegates = (live.depth && call === 0) || (live.delegation && call < 2);
  // Force exactly two real tool invocations in the collaboration scenario.
  // Choosing a tool is host policy supported by the native model interface;
  // the runtime still validates, creates, runs and verifies every child.
  return rootStream({
    ...args,
    maxOutputTokens: LIVE_LIMITS.outputTokens,
    // Both child agents are registered on Main. Constrain this scenario's
    // model-facing choice so repeated delegation cannot accidentally choose
    // Builder and add an unrelated Reviewer run to its two-child assertion.
    tools: delegates
      ? args.tools?.map((tool) =>
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
        )
      : [],
    toolChoice: delegates ? { type: "tool", toolName: "agevex_delegate" } : { type: "none" },
  });
};
const childModel = provider.chat(modelId);
const childStream = childModel.doStream.bind(childModel);
childModel.doStream = (args) => {
  live.childCalls++;
  // This scenario requires a terminal Researcher answer. Withhold the tool
  // inventory as well as setting toolChoice:none: some free routes otherwise
  // emit a blocking ask_parent call despite that provider setting.
  return childStream({
    ...args,
    maxOutputTokens: LIVE_LIMITS.outputTokens,
    tools: [],
    toolChoice: { type: "none" },
  });
};
const usageHandler = (
  _ctx: unknown,
  { usage }: { usage: { inputTokens?: number; outputTokens?: number } },
) => {
  live.inputTokens += usage.inputTokens ?? 0;
  live.outputTokens += usage.outputTokens ?? 0;
};
// A forced tool choice may return several calls. Use F1's host policy to admit
// one per turn instead of requesting unsupported parallel_tool_calls=false.
// At most LIVE_LIMITS.requests live turns add thread ids; each turn clears its
// own entry before generation. Native calls, launches and results remain real.
const delegatedThreads = new Set<string>();
const oneDelegatePerTurn: AgentHooks = {
  beforeTurn: (hc) => {
    delegatedThreads.delete(hc.threadId);
  },
  beforeDelegate: (hc) => {
    if (delegatedThreads.has(hc.threadId)) return { block: "one live delegation per turn" };
    delegatedThreads.add(hc.threadId);
  },
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
    // Match the root's model-facing constraint: the depth scenario requires
    // Reviewer, while a forced tool choice alone leaves its agent argument
    // unconstrained. Every child still uses the real managed delegation path.
    tools:
      call === 0
        ? args.tools?.map((tool) =>
            tool.type === "function" && tool.name === "agevex_delegate"
              ? {
                  ...tool,
                  inputSchema: {
                    ...tool.inputSchema,
                    properties: {
                      ...tool.inputSchema.properties,
                      agent: { type: "string", enum: ["Reviewer"] },
                    },
                  },
                }
              : tool,
          )
        : [],
    toolChoice: call === 0 ? { type: "tool", toolName: "agevex_delegate" } : { type: "none" },
  });
};
const builder = new Agent(native, {
  name: "Builder",
  languageModel: builderModel,
  subagents: [reviewer],
  hooks: oneDelegatePerTurn,
  usageHandler,
  instructions:
    "First delegate one very short task to Reviewer. When its result arrives, reply in one short sentence. Never delegate to any other agent.",
});
const main = new Agent(native, {
  name: "Main",
  languageModel: rootModel,
  subagents: [child, builder],
  hooks: oneDelegatePerTurn,
  instructions:
    "For a depth-two task delegate exactly once to Builder, then give a short final answer after its result. For other tasks use Researcher when required to delegate. Use a very short factual task. After the second Researcher result, reply in one short sentence. Never delegate to any other agent.",
  usageHandler,
});
const criticModel = provider.chat(modelId);
const criticStream = criticModel.doStream.bind(criticModel);
criticModel.doStream = (args) => {
  live.criticCalls++;
  return criticStream({
    ...args,
    maxOutputTokens: LIVE_LIMITS.outputTokens,
    toolChoice: { type: "none" },
  });
};
const critic = new Agent(native, {
  name: "Critic",
  languageModel: criticModel,
  usageHandler,
  instructions: "Give one short useful review note. Do not return NONE. Do not call tools.",
});
const watched = new Agent(native, {
  name: "Watched",
  languageModel: rootModel,
  usageHandler,
  sideAgents: [{ agent: critic, every: { turns: 1 }, sees: "delta" }],
  instructions: "Answer in one short sentence.",
});
const runtime = registerAgent(agevex, {
  agents: [main, watched],
  usage: fakeUsage,
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
