/** Deterministic host for background-text guarantees; no provider or network. */
import { mockModel } from "@convex-dev/agent";
import {
  anyApi,
  makeFunctionReference,
  type ApiFromModules,
  type FunctionReference,
} from "convex/server";
import {
  Agent,
  registerAgent,
  type Registration,
  type SlotFacts,
  type UsageEvent,
  type TextTaskArgs,
  type TurnArgs,
} from "../src/client/index.js";
import { components } from "./fixture/api.js";

type Call = Parameters<ReturnType<typeof mockModel>["doGenerate"]>[0];
export const state = {
  title: undefined as Registration["title"],
  titleCalls: [] as Call[],
  mainCalls: [] as Call[],
  usage: [] as { facts: SlotFacts; requestId?: string }[],
  titleGate: undefined as Promise<void> | undefined,
  mainGate: undefined as Promise<void> | undefined,
  authorizeGate: undefined as Promise<void> | undefined,
  authorizing: 0,
  padding: "",
  answer: "assistant answer",
  titleText: "Generated title",
  revoke: false,
  denyBudget: false,
  usageFails: false,
  titleUsageFailures: 0,
  titleUsageStalls: false,
  usageAttempts: [] as UsageEvent[],
};

/** Shared root model also answers default-title structured calls. */
function model(kind: "main" | "title") {
  const model = mockModel();

  model.doGenerate = async (args) => {
    const actual = kind === "main" && args.responseFormat?.type === "json" ? "title" : kind;

    state[`${actual}Calls`].push(args);
    await state[`${actual}Gate`];

    const text =
      actual === "main"
        ? state.answer
        : JSON.stringify({
            text: state.titleText,
          });

    const source = mockModel({
      content: [{ type: "text", text }],
    });

    return {
      ...(await source.doGenerate(args)),
      response: { id: `request-${actual}` },
      ...(actual === "main" && state.padding
        ? { providerMetadata: { fixture: { padding: state.padding } } }
        : {}),
    };
  };

  return model;
}
export const titleModel = model("title");

const main = new Agent(components.agent, {
  name: "Main",
  languageModel: model("main"),
  run: { mode: "generate" },
});

/** Resolve references exactly as a host exporting runtime.internalFunctions. */
export function registration() {
  return registerAgent(components.agevex, {
    agents: [main],
    title: state.title,
    refs: {
      runTurn: () =>
        makeFunctionReference<"action", TurnArgs, null>(
          "agents:runTurn",
        ) as unknown as FunctionReference<"action", "internal", TurnArgs, null>,
      textTask: () =>
        makeFunctionReference<"action", TextTaskArgs, null>(
          "agents:textTask",
        ) as unknown as FunctionReference<"action", "internal", TextTaskArgs, null>,
    },
    authorize: async (ctx) => {
      const identity = await ctx.auth.getUserIdentity();

      if (!identity) throw new Error("FORBIDDEN");

      return { subject: identity.subject };
    },
    authorizeExecution: async (_ctx, scope) => {
      if (scope.purpose) {
        state.authorizing++;
        await state.authorizeGate;
      }

      if (scope.subject !== "alice" || (state.revoke && scope.purpose))
        throw new Error("FORBIDDEN");
    },
    budget: { check: async () => ({ allowed: !state.denyBudget }) },
    usage: {
      record: async (_ctx, event) => {
        state.usageAttempts.push(event);

        if (event.purpose === "title") {
          if (state.titleUsageStalls) await new Promise<void>(() => {});

          if (state.titleUsageFailures-- > 0) throw new Error("transient ledger failure");
        }

        if (state.usageFails) throw new Error("usage hook unavailable");

        state.usage.push({ facts: event, requestId: event.requestId });
      },
    },
  });
}
export function exports() {
  const runtime = registration();

  return { ...runtime.internalFunctions(), ...runtime.authorizedEndpoints() };
}
export const api = anyApi as unknown as ApiFromModules<{ agents: ReturnType<typeof exports> }>;

export function reset() {
  state.authorizeGate = undefined;
  state.authorizing = 0;
  state.padding = "";
  state.answer = "assistant answer";
  state.titleText = "Generated title";
  state.title = undefined;
  state.mainCalls = [];
  state.titleCalls = [];
  state.usage = [];
  state.titleGate = undefined;
  state.mainGate = undefined;
  state.revoke = false;
  state.denyBudget = false;
  state.usageFails = false;
  state.titleUsageFailures = 0;
  state.titleUsageStalls = false;
  state.usageAttempts = [];
}
