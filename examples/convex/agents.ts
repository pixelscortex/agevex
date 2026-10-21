import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  Agent,
  registerAgent,
  type CoordinateArgs,
  type CoordinateResult,
  type TurnArgs,
} from "agevex";
import type { FunctionReference, RegisteredAction, RegisteredMutation } from "convex/server";

import { components, internal } from "./_generated/api.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

const model = openrouter("minimax/minimax-m3.1-flash:free");

const specialist = new Agent(components.agent, {
  name: "specialist",
  languageModel: model,
  instructions:
    "You are a focused research specialist. Answer the delegated question clearly and briefly.",
  subagents: [],
});

const main = new Agent(components.agent, {
  name: "main",
  languageModel: model,
  instructions:
    "You are a helpful assistant. Use the native conversation and delegate focused research when useful.",
  subagents: [specialist],
});

const allowAnonymous = process.env.AGEVEX_ALLOW_ANONYMOUS === "true";
const demoSubject = allowAnonymous ? process.env.AGEVEX_DEMO_SUBJECT : undefined;

const runtime = registerAgent(components.agevex, {
  agents: [main],
  refs: {
    runTurn: (): FunctionReference<"action", "internal", TurnArgs, null> => internal.agents.runTurn,
    coordinate: (): FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult> =>
      internal.agents.coordinate,
  },
  authorize: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity) return { subject: identity.subject };
    if (demoSubject) return { subject: demoSubject };
    throw new Error("UNAUTHENTICATED");
  },
  authorizeExecution: async () => {},
});

export const runTurn: RegisteredAction<"internal", TurnArgs, null> =
  runtime.internalFunctions().runTurn;

export const coordinate: RegisteredMutation<"internal", CoordinateArgs, CoordinateResult> =
  runtime.internalFunctions().coordinate;

export const { open, send, messages, activity, delegations } = runtime.authorizedEndpoints();
