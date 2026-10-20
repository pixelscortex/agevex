// Deterministic host registration used by the component tests.
//
// `Main` declares `Researcher` as its single delegation child, so the tests
// exercise the real graph rather than a Main-only stub. Every model is a native
// `mockModel`: no provider, no key, no network. Delegation is opt-in per test
// through `state.delegate`, so the root transcript never changes shape unless a
// test asks for it.
//
// Background authorization policy: `delegate`/`deliver` run from the Workpool
// action with no end user on the connection, so `ctx.auth` is null there. The
// policy branches on the operation and rechecks the capability-validated
// persisted principal against the current allowed set, instead of echoing the
// supplied subject back.

import {
  Agent,
  registerAgevex,
  type CoordinateArgs,
  type CoordinateResult,
  type TurnArgs,
} from "../src/client/index.js";
import { mockModel } from "@convex-dev/agent";
import { tool } from "ai";
import { z } from "zod";
import {
  makeFunctionReference,
  type FunctionReference,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { components } from "./fixture/api.js";

type OfferedCall = { agent: "Main" | "Researcher"; tools: string[] };
const toolNames = (tools: unknown): string[] =>
  Array.isArray(tools) ? tools.map((entry) => (entry as { name?: string }).name ?? "?") : [];

export const state = {
  calls: [] as Parameters<ReturnType<typeof mockModel>["doStream"]>[0][],
  /** Tool names offered on each model call, in call order. */
  offers: [] as OfferedCall[],
  fail: false,
  revoke: false,
  hang: false,
  tools: false,
  /** Emit one `agevex_delegate` tool call on every root step. */
  delegate: false,
  /**
   * How many `agevex_delegate` tool calls one root model step emits when
   * `delegate` is set. `1` is the default single-call behaviour; values above
   * one put every call in the SAME step, which is what an explicit multi-task
   * request looks like. They stay separate launches because each call keeps its
   * own native tool call id.
   */
  delegateFanout: 1,
  /** Child agent name requested by the emitted delegation tool call. */
  delegateAgent: "Researcher",
  /** Task text requested by the emitted delegation tool call. */
  delegateTask: "research the bounded question",
  /** Refuse the launch in the host authorization policy. */
  denyDelegate: false,
  /** Refuse delivery in the host authorization policy. */
  denyDeliver: false,
  /** Refuse execution of a delegated child turn. */
  revokeChild: false,
  /** Virtual per-call generation cost, elapsed on the test's fake clock. */
  delayMs: 0,
  release: undefined as undefined | (() => void),
  gate: undefined as undefined | Promise<void>,
  /** Child-only controls, so a root turn can be held still independently. */
  childText: "RESEARCHER deterministic native result",
  childFail: false,
  childDelayMs: 0,
  childRelease: undefined as undefined | (() => void),
  childGate: undefined as undefined | Promise<void>,
};

const model = mockModel({ content: [{ type: "text", text: "DEMO deterministic native reply" }] });
const original = model.doStream.bind(model);
const toolModel = mockModel({
  contentSteps: [
    [{ type: "tool-call", toolCallId: "demo-tool", toolName: "echo", input: '{"text":"echoed"}' }],
    [{ type: "text", text: "MUST NOT RUN A SECOND STEP" }],
  ],
});
/**
 * Delegation reply, built per call so `state.delegateAgent`/`state.delegateTask`
 * are read at emission time rather than frozen at module load. A fanout above
 * one emits every tool call in the first content step, so the root asks for all
 * of its tasks in one model step instead of waiting between them.
 */
const delegateReply = () =>
  mockModel({
    contentSteps: [
      Array.from({ length: state.delegateFanout }, (_unused, index) => ({
        type: "tool-call" as const,
        toolCallId: state.delegateFanout === 1 ? "delegate-call" : `delegate-call-${index + 1}`,
        toolName: "agevex_delegate",
        input: JSON.stringify({ agent: state.delegateAgent, task: state.delegateTask }),
      })),
      [{ type: "text", text: "Main acknowledged the queued delegation." }],
    ],
  });
/** The managed delegation tool is offered to this model call? */
const offersDelegation = (tools: unknown) => toolNames(tools).includes("agevex_delegate");
model.doStream = async (args) => {
  state.calls.push(args);
  state.offers.push({ agent: "Main", tools: toolNames(args.tools) });
  if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
  if (state.hang)
    await new Promise<never>((_resolve, reject) => {
      args.abortSignal?.addEventListener("abort", () => reject(new Error("aborted demo")), {
        once: true,
      });
    });
  if (state.gate) await state.gate;
  if (state.fail) throw new Error("private provider error must not leak");
  if (state.tools) return toolModel.doStream(args);
  if (state.delegate && offersDelegation(args.tools)) return delegateReply().doStream(args);
  return original(args);
};

/** Child reply, built per call so `state.childText` is read at emission time. */
const childReply = () =>
  mockModel({
    provider: "agevex-local-demo",
    modelId: "DEMO-not-a-real-model",
    content: [{ type: "text", text: state.childText }],
  });
const childModel = mockModel({
  provider: "agevex-local-demo",
  modelId: "DEMO-not-a-real-model",
  content: [{ type: "text", text: "RESEARCHER deterministic native result" }],
});
childModel.doStream = async (args) => {
  state.offers.push({ agent: "Researcher", tools: toolNames(args.tools) });
  if (state.childDelayMs > 0)
    await new Promise((resolve) => setTimeout(resolve, state.childDelayMs));
  if (state.childGate) await state.childGate;
  if (state.childFail) throw new Error("private child provider error must not leak");
  return childReply().doStream(args);
};

export const researcher = new Agent(components.agent, {
  name: "Researcher",
  languageModel: childModel,
  subagents: [],
});
export const main = new Agent(components.agent, {
  name: "Main",
  languageModel: model,
  tools: {
    echo: tool({ inputSchema: z.object({ text: z.string() }), execute: ({ text }) => text }),
  },
  subagents: [researcher],
});

/** Current policy: which persisted owners may keep a background operation alive. */
const ALLOWED_BACKGROUND_SUBJECTS = new Set(["alice"]);

const runTurnRef = makeFunctionReference<"action", TurnArgs, null>(
  "agents:runTurn",
) as unknown as FunctionReference<"action", "internal", TurnArgs, null>;

const runtime = registerAgevex(components.agevex, {
  agents: [main],
  refs: {
    runTurn: () => runTurnRef,
    // The fixture app's generated api is generic and enumerates no exported
    // function, so the coordinator is addressed by name. This points at the
    // real registered mutation exported below by that name; Convex resolves it
    // by the name, and the visibility marker `makeFunctionReference` types as
    // "public" is phantom and has no runtime effect.
    coordinate: () =>
      makeFunctionReference<"mutation", CoordinateArgs, CoordinateResult>(
        "agents:coordinate",
      ) as unknown as FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult>,
  },
  authorize: async (ctx, scope) => {
    if (scope.operation === "delegate" || scope.operation === "deliver") {
      if (scope.operation === "delegate" && state.denyDelegate) throw new Error("DENIED");
      if (scope.operation === "deliver" && state.denyDeliver) throw new Error("DENIED");
      if (!ALLOWED_BACKGROUND_SUBJECTS.has(scope.subject)) throw new Error("FORBIDDEN");
      if (scope.operation === "delegate" && scope.childAgent !== "Researcher")
        throw new Error("FORBIDDEN");
      return { subject: scope.subject };
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("UNAUTHENTICATED");
    return { subject: identity.subject };
  },
  authorizeExecution: async (_ctx, scope) => {
    if (state.revoke || scope.subject !== "alice") throw new Error("REVOKED");
    if (scope.child && state.revokeChild) throw new Error("REVOKED_CHILD");
  },
});
const { runTurn, coordinate } = runtime.internalFunctions();
export { runTurn, coordinate };
export const { open, send, messages, activity, delegations } = runtime.authorizedEndpoints();

/**
 * Reference to the authorized `delegations` query of the *test* registration.
 *
 * Kept separate from the destructured `delegations` export so a test reads the
 * same query a host would call, by reference rather than by direct import. It
 * addresses the real registered query, not a stub.
 */
export const delegationsQuery = makeFunctionReference<"query">(
  "agents:delegations",
) as unknown as FunctionReference<
  "query",
  "public",
  { threadId: string; paginationOpts: PaginationOptions },
  PaginationResult<unknown>
>;

/** Coordinator reference for direct capability probes in tests. */
export const coordinateReference = () =>
  makeFunctionReference<"mutation", CoordinateArgs, CoordinateResult>(
    "agents:coordinate",
  ) as unknown as FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult>;

/**
 * Reference to the registered host turn runner, as `reserve` stores it on a run.
 */
export const runTurnReference = () =>
  runTurnRef as unknown as FunctionReference<"action", "internal", TurnArgs, null>;

/** Release every held child generation. */
export function releaseChild() {
  state.childRelease?.();
  state.childRelease = undefined;
  state.childGate = undefined;
}
