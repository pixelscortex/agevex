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
  type TextTaskArgs,
  type TurnArgs,
} from "../src/client/index.js";
import { components } from "./fixture/api.js";

type Call = Parameters<ReturnType<typeof mockModel>["doGenerate"]>[0];
export const state = {
  title: undefined as Registration["title"],
  summary: undefined as Registration["summary"],
  titleCalls: [] as Call[],
  summaryCalls: [] as Call[],
  mainCalls: [] as Call[],
  usage: [] as { facts: SlotFacts; requestId?: string }[],
  titleGate: undefined as Promise<void> | undefined,
  mainGate: undefined as Promise<void> | undefined,
  summaryGate: undefined as Promise<void> | undefined,
  authorizeGate: undefined as Promise<void> | undefined,
  authorizing: 0,
  summaryText: "Summary of earlier turns",
  padding: "",
  answer: "assistant answer",
  titleText: "Generated title",
  failSummary: false,
  invalidSummary: false,
  revoke: false,
  denyBudget: false,
  usageFails: false,
};

/** Shared root model also answers default-title structured calls. */
function model(kind: "main" | "title" | "summary") {
  const model = mockModel();

  model.doGenerate = async (args) => {
    const actual = kind === "main" && args.responseFormat?.type === "json" ? "title" : kind;

    state[`${actual}Calls`].push(args);
    await state[`${actual}Gate`];

    if (actual === "summary" && state.failSummary) throw new Error("provider disconnected");

    const text =
      actual === "main"
        ? state.answer
        : JSON.stringify({
            text:
              actual === "title" ? state.titleText : state.invalidSummary ? "" : state.summaryText,
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
export const summaryModel = model("summary");

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
    summary: state.summary,
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
      scope: (_ctx, facts) => ({
        estimate: async () => {
          throw new Error("unexpected estimate");
        },
        record: async (_provider, args) => {
          if (state.usageFails) throw new Error("meter unavailable");

          state.usage.push({ facts, requestId: args.requestId });

          return {
            key: args.key,
            attach: async () => {},
            correct: async () => {},
            settle: async () => {},
            get: async () => null,
          };
        },
      }),
    },
  });
}
export function exports() {
  const runtime = registration();

  return { ...runtime.internalFunctions(), ...runtime.authorizedEndpoints() };
}
export const api = anyApi as unknown as ApiFromModules<{ agents: ReturnType<typeof exports> }>;

/** Each test starts with title on and summary absent, matching public defaults. */
export function reset() {
  state.authorizeGate = undefined;
  state.authorizing = 0;
  state.summaryText = "Summary of earlier turns";
  state.padding = "";
  state.answer = "assistant answer";
  state.titleText = "Generated title";
  state.title = undefined;
  state.summary = undefined;
  state.mainCalls = [];
  state.titleCalls = [];
  state.summaryCalls = [];
  state.usage = [];
  state.titleGate = undefined;
  state.summaryGate = undefined;
  state.mainGate = undefined;
  state.failSummary = false;
  state.invalidSummary = false;
  state.revoke = false;
  state.denyBudget = false;
  state.usageFails = false;
}
