// Deterministic host registration used by the component tests.
//
// `Main` declares `Researcher` as its single delegation child, so the tests
// exercise the real graph rather than a Main-only stub. Every model is a native
// `mockModel`: no provider, no key, no network. Delegation is opt-in per test
// through `state.delegate`, so the root transcript never changes shape unless a
// test asks for it.
//
// Background authorization policy: `delegate`/`deliver` run from a Workflow slice
// action with no end user on the connection, so `ctx.auth` is null there. The
// policy branches on the operation and rechecks the capability-validated
// persisted principal against the current allowed set, instead of echoing the
// supplied subject back.

import {
  Agent,
  registerAgent,
  defineOnceTool,
  type ToolContext,
  type AgentEvent,
  type CoordinateArgs,
  type CoordinateResult,
  type TurnArgs,
  type Registration,
} from "../src/client/index.js";
import { scriptedModel } from "../src/test.js";
import { createTool, mockModel } from "@convex-dev/agent";
import { tool } from "ai";
import { z } from "zod";
import {
  internalActionGeneric,
  internalMutationGeneric,
  makeFunctionReference,
  type FunctionReference,
  type RegisteredAction,
  type RegisteredMutation,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { components } from "./fixture/api.js";

type OfferedCall = { agent: "Main" | "Researcher"; tools: string[] };
const toolNames = (tools: unknown): string[] =>
  Array.isArray(tools) ? tools.map((entry) => (entry as { name?: string }).name ?? "?") : [];

export const state = {
  deferred: false,
  deferredCount: 1,
  deferredQuestion: "Which option?",
  overrideCalls: [] as string[],
  overrideTools: false,
  dropPing: false,
  forbidTranscriptReads: false,
  transcriptReads: 0,
  nestedCalls: 0,
  nestedAfterCancel: false,
  nativeNested: false,
  nestedStarted: false,
  nestedErrors: [] as unknown[],
  nestedSignals: [] as boolean[],
  nestedRelease: undefined as undefined | (() => void),
  nestedGate: undefined as undefined | Promise<void>,
  childToolSlices: 0,
  modelStarted: undefined as undefined | (() => void),
  calls: [] as Parameters<ReturnType<typeof mockModel>["doStream"]>[0][],
  /** Tool names offered on each model call, in call order. */
  offers: [] as OfferedCall[],
  events: [] as AgentEvent[],
  observerFails: false,
  fail: false,
  revoke: false,
  hang: false,
  tools: false,
  approval: false,
  approvalCount: 1,
  echoStarted: false,
  echoGate: undefined as undefined | Promise<void>,
  cleanupFails: false,
  childApproval: false,
  childDeferred: false,
  once: false,
  onceCalls: 0,
  onceContext: undefined as ToolContext | undefined,
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
  delegationRounds: 1,
  delegatedRounds: 0,
  roundsByPrompt: new Map<string, number>(),
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
const toolModel = scriptedModel([
  [{ type: "tool-call", toolCallId: "demo-tool", toolName: "echo", input: '{"text":"echoed"}' }],
  [{ type: "text", text: "MUST NOT RUN A SECOND STEP" }],
]);
/**
 * Delegation reply, built per call so `state.delegateAgent`/`state.delegateTask`
 * are read at emission time rather than frozen at module load. A fanout above
 * one emits every tool call in the first content step, so the root asks for all
 * of its tasks in one model step instead of waiting between them.
 */
const delegateReply = () =>
  scriptedModel([
    Array.from({ length: state.delegateFanout }, (_unused, index) => ({
      type: "tool-call" as const,
      toolCallId: state.delegateFanout === 1 ? "delegate-call" : `delegate-call-${index + 1}`,
      toolName: "agevex_delegate",
      input: JSON.stringify({
        agent: state.delegateAgent,
        task:
          state.childToolSlices > 0 && index === 0
            ? state.delegateTask + " keep slicing"
            : state.delegateTask,
      }),
    })),
    [{ type: "text", text: "Main acknowledged the queued delegation." }],
  ]);
/** The managed delegation tool is offered to this model call? */
const offersDelegation = (tools: unknown) => toolNames(tools).includes("agevex_delegate");
model.doStream = async (args) => {
  state.calls.push(args);
  state.modelStarted?.();
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
  if (state.nestedAfterCancel)
    return scriptedModel([
      [
        {
          type: "tool-call",
          toolName: state.nativeNested ? "nativeNested" : "nested",
          toolCallId: "nested",
          input: "{}",
        },
      ],
    ]).doStream(args);
  if (state.once && state.calls.length <= 2)
    return scriptedModel([
      [
        {
          type: "tool-call",
          toolName: "once",
          toolCallId: `effect-${state.calls.length}`,
          input: JSON.stringify({ text: "one effect" }),
        },
      ],
    ]).doStream(args);
  if (state.approval && state.calls.length === 1)
    return scriptedModel([
      Array.from({ length: state.approvalCount }, (_, i) => ({
        type: "tool-call" as const,
        toolCallId: "approval-call-" + i,
        toolName: "echo",
        input: '{"text":"echoed"}',
      })),
    ]).doStream(args);
  if (state.deferred && state.calls.length === 1)
    return scriptedModel([
      Array.from({ length: state.deferredCount }, (_, i) => ({
        type: "tool-call" as const,
        toolCallId: `question-${i}`,
        toolName: "askHuman",
        input: JSON.stringify({ question: state.deferredQuestion }),
      })),
    ]).doStream(args);
  if (state.tools && state.calls.length === 1) return toolModel.doStream(args);
  const prompt = JSON.stringify(
    args.prompt
      .filter(
        (message) =>
          message.role === "user" &&
          !JSON.stringify(message.content).includes("the delegated task"),
      )
      .slice(-1),
  );
  const rounds = state.roundsByPrompt.get(prompt) ?? 0;
  if (state.delegate && rounds < state.delegationRounds && offersDelegation(args.tools)) {
    state.delegatedRounds++;
    state.roundsByPrompt.set(prompt, rounds + 1);
    return delegateReply().doStream(args);
  }
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
  if (
    state.childDeferred &&
    state.offers.filter((offer) => offer.agent === "Researcher").length === 1
  )
    return scriptedModel([
      [
        {
          type: "tool-call",
          toolCallId: "child-question",
          toolName: "askHuman",
          input: '{"question":"Child question?"}',
        },
      ],
    ]).doStream(args);
  if (
    (state.childApproval || state.childToolSlices > 0) &&
    JSON.stringify(args.prompt).includes("keep slicing") &&
    state.offers.filter((offer) => offer.agent === "Researcher").length <=
      (state.childApproval ? 1 : state.childToolSlices)
  )
    return scriptedModel([
      [
        {
          type: "tool-call",
          toolName: "echo",
          toolCallId: crypto.randomUUID(),
          input: '{"text":"slice"}',
        },
      ],
    ]).doStream(args);
  return childReply().doStream(args);
};

export const researcher = new Agent(components.agent, {
  name: "Researcher",
  languageModel: childModel,
  subagents: [],
});
// Opt-in fixture tools preserve the tool-less child promised by existing tests.
Object.defineProperty(researcher, "declaredTools", {
  get: () =>
    state.childApproval || state.childToolSlices > 0 || state.childDeferred
      ? {
          askHuman: tool({ inputSchema: z.object({ question: z.string() }) }),
          echo: tool({
            inputSchema: z.object({ text: z.string() }),
            needsApproval: () => state.childApproval,
            execute: ({ text }) => text,
          }),
        }
      : {},
});
export const main = new Agent(components.agent, {
  name: "Main",
  languageModel: model,
  tools: {
    askHuman: tool({ inputSchema: z.object({ question: z.string() }) }),
    nativeNested: createTool({
      inputSchema: z.object({}),
      execute: async (ctx, _input, options) => {
        state.nestedStarted = true;
        if (state.nestedGate) await state.nestedGate;
        try {
          await ctx.runAction(makeFunctionReference<"action">("agents:nestedAction"), {});
        } catch (error) {
          state.nestedErrors.push(error);
          state.nestedSignals.push(options.abortSignal?.aborted ?? false);
        }
        try {
          await ctx.runMutation(makeFunctionReference<"mutation">("agents:nestedMutation"), {});
        } catch (error) {
          state.nestedErrors.push(error);
          state.nestedSignals.push(options.abortSignal?.aborted ?? false);
        }
        return null;
      },
    }),
    nested: defineOnceTool({
      name: "nested-cancel-probe",
      input: z.object({}),
      run: async (_input, tc) => {
        state.nestedStarted = true;
        if (state.nestedGate) await state.nestedGate;
        try {
          await tc.ctx.runAction(makeFunctionReference<"action">("agents:nestedAction"), {});
        } catch (error) {
          state.nestedErrors.push(error);
          state.nestedSignals.push(tc.signal.aborted);
        }
        try {
          await tc.ctx.runMutation(makeFunctionReference<"mutation">("agents:nestedMutation"), {});
        } catch (error) {
          state.nestedErrors.push(error);
          state.nestedSignals.push(tc.signal.aborted);
        }
        return null;
      },
    }),
    once: defineOnceTool({
      name: "one-effect",
      input: z.object({ text: z.string() }),
      key: () => "stable-effect",
      run: (input, tc) => {
        state.onceCalls++;
        state.onceContext = tc;
        return { saved: input.text };
      },
    }),
    echo: tool({
      inputSchema: z.object({ text: z.string() }),
      needsApproval: () => state.approval,
      execute: async ({ text }) => {
        state.echoStarted = true;
        if (state.echoGate) await state.echoGate;
        return text;
      },
    }),
  },
  subagents: [researcher],
});

/** Current policy: which persisted owners may keep a background operation alive. */
const ALLOWED_BACKGROUND_SUBJECTS = new Set(["alice"]);

const runTurnRef = makeFunctionReference<"action", TurnArgs, null>(
  "agents:runTurn",
) as unknown as FunctionReference<"action", "internal", TurnArgs, null>;

const overrideModel = (id: string) => {
  const override = mockModel({ content: [{ type: "text", text: `model ${id}` }] });
  const native = override.doStream.bind(override);
  override.doStream = async (args) => {
    state.overrideCalls.push(id);
    if (state.overrideTools && state.overrideCalls.length === 1) return toolModel.doStream(args);
    return native(args);
  };
  return override;
};

export function fixtureRuntime(limits?: Registration["limits"]) {
  return registerAgent(components.agevex, {
    limits,
    agents: [main],
    models: overrideModel,
    modelAllowlist: ["first", "second", "😀".repeat(100), "x".repeat(90), "x".repeat(91)],
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
    observe: async (_ctx, event) => {
      if (state.observerFails) throw new Error("observer failure");
      state.events.push(event);
    },
  });
}
const runtime = fixtureRuntime();
export const nestedAction: RegisteredAction<"internal", {}, null> = internalActionGeneric({
  handler: async () => {
    state.nestedCalls++;
    return null;
  },
});
export const nestedMutation: RegisteredMutation<"internal", {}, null> = internalMutationGeneric({
  handler: async () => {
    state.nestedCalls++;
    return null;
  },
});
const { runTurn, coordinate } = runtime.internalFunctions();
export { runTurn, coordinate };
export const { open, send, respond, answer, cancel, messages, streams, activity, delegations } =
  runtime.authorizedEndpoints();

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
