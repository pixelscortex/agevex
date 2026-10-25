import {
  internalActionGeneric,
  queryGeneric,
  componentsGeneric,
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";
import { ConvexError, v, type Value } from "convex/values";
import type { Tool } from "ai";
import type { AgentComponent } from "@convex-dev/agent";
import { bindOnceTool, noopMeter, type ToolContext } from "../../../src/client/once.js";
import type { ComponentApi as CoreApi } from "../../../src/component/_generated/component.js";
import { defineSandbox } from "../../../src/modules/sandbox/client/index.js";
import type { ComponentApi } from "../../../src/modules/sandbox/component/_generated/component.js";
import type { SandboxLimits } from "../../../src/modules/sandbox/shared/limits.js";
import type {
  PollArgs,
  PollActionArgs,
  SettleArgs,
  SandboxJobEvent,
  SandboxUsageEvent,
  SandboxOptions,
  SandboxExportArgs,
  SandboxExportResult,
  SandboxContext,
} from "../../../src/modules/sandbox/client/types.js";
import { fakeSandboxProvider } from "../../../src/testing/sandbox.js";

const components = componentsGeneric() as unknown as {
  sandbox: ComponentApi;
  agevex: CoreApi;
  agent: AgentComponent;
};

const ref = <T extends "action" | "mutation", A extends Record<string, Value>>(name: string) =>
  makeFunctionReference<T, A, null>(`host:${name}`) as unknown as FunctionReference<
    T,
    "internal",
    A,
    null
  >;

export const state = {
  fake: fakeSandboxProvider(),
  scope: "thread" as "thread" | "run" | "subject",
  limits: {} as Partial<SandboxLimits>,
  authorized: true,
  /** What the host's policy throws while `authorized` is false. */
  deniedWith: "HOST_DENIED",
  /** Throw `new ConvexError(deniedWith)` instead of an Error. */
  deniedAsConvexError: false,
  /** Runs once, inside the next "use" authorization (just before its reserve). */
  beforeUse: undefined as undefined | ((ctx: SandboxContext) => Promise<void>),
  /** Poll actions that die before doing any work, like a killed isolate. */
  crashPolls: 0,
  callbackFails: false,
  usageFails: false,
  usage: [] as SandboxUsageEvent[],
  resolver: undefined as undefined | { subject: string; threadId: string; runId: string },
  nodeExport: false,
  instance: undefined as undefined | ReturnType<typeof defineSandbox>,
};

export function config(): SandboxOptions {
  return {
    component: components.sandbox,
    provider: state.fake.provider,
    scope: state.scope,
    limits: state.limits,
    agent: components.agent,
    ...(state.nodeExport
      ? {
          nodeExport: makeFunctionReference<"action", SandboxExportArgs, SandboxExportResult>(
            "node:exportFile",
          ) as unknown as FunctionReference<
            "action",
            "internal",
            SandboxExportArgs,
            SandboxExportResult
          >,
        }
      : {}),
    refs: {
      wake: () => ref<"mutation", PollArgs>("wake"),
      poll: () => ref<"action", PollActionArgs>("poll"),
      settle: () => ref<"mutation", SettleArgs>("settle"),
      cleanup: () => ref<"action", Record<string, never>>("cleanup"),
    },
    authorize: async (_ctx, request) => {
      if (!state.authorized)
        throw state.deniedAsConvexError
          ? new ConvexError(state.deniedWith)
          : new Error(state.deniedWith);

      if (request.operation === "use" && state.beforeUse) {
        const hook = state.beforeUse;

        state.beforeUse = undefined;
        await hook(_ctx as SandboxContext);
      }

      return { subject: request.subject ?? "owner" };
    },
    resolveThread: async (_ctx, threadId) =>
      state.resolver ?? { subject: "owner", threadId, runId: "run" },
    onComplete: async (ctx, event: SandboxJobEvent) => {
      await ctx.db.insert("events", { value: event });

      if (state.callbackFails) throw new Error("HOST_CALLBACK_FAILED");
    },
    usage: {
      record: async (_ctx, event) => {
        if (state.usageFails) throw new Error("HOST_USAGE_FAILED");

        state.usage.push(event);
      },
    },
  };
}

export function runtime() {
  const sandbox = defineSandbox(config());

  state.instance = sandbox;
  const functions = sandbox.internalFunctions();

  // Registered functions keep their handler; wrap it to model an action that
  // dies before it does anything (after the scheduler already consumed it).
  const real = (functions.poll as unknown as { _handler: (ctx: unknown, args: unknown) => unknown })
    ._handler;

  const poll = internalActionGeneric({
    args: { jobId: v.string(), claim: v.string() },
    handler: async (ctx, args) => {
      if (state.crashPolls > 0) {
        state.crashPolls--;
        throw new Error("poll action died");
      }

      return real(ctx, args) as Promise<null>;
    },
  });

  return { ...functions, poll };
}

export const invoke = internalActionGeneric({
  args: {
    op: v.string(),
    input: v.any(),
    subject: v.optional(v.string()),
    threadId: v.optional(v.string()),
    runId: v.optional(v.string()),
    key: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Value> => {
    const sandbox = state.instance!;

    const tc: ToolContext = {
      ctx,
      subject: args.subject ?? "owner",
      threadId: args.threadId ?? "thread",
      rootThreadId: args.threadId ?? "thread",
      agent: "SandboxTest",
      meter: noopMeter,
      runId: args.runId ?? "run",
      toolCallId: args.key ?? crypto.randomUUID(),
      signal: new AbortController().signal,
    };

    switch (args.op) {
      case "prepare":
        return sandbox.prepare(tc);
      case "stop":
        await sandbox.stop(tc);

        return null;
      case "delete":
        await sandbox.delete(tc);

        return null;
      case "export":
        return sandbox.export(ctx, { threadId: tc.threadId, path: args.input.path });
      case "forget":
        return sandbox.forget(ctx, args.input);
      case "cleanup":
        await sandbox.cleanup(ctx);

        return null;
      case "job":
        return sandbox.job(ctx, { jobId: args.input.jobId });
      default: {
        const tools = sandbox.tools(tc);
        const declared = tools[args.op as keyof typeof tools] as Tool;

        if (!declared) throw new Error("UNKNOWN_TEST_TOOL");

        const seed = componentsGeneric()["agevex"]["sandboxFixture"]["seed"] as FunctionReference<
          "mutation",
          "internal",
          Record<string, never>,
          string
        >;

        const assignmentId = await ctx.runMutation(seed, {});

        const bound = bindOnceTool(
          declared,
          components.agevex,
          ctx,
          tc,
          { assignmentId, executionId: "execution", cancellationEpoch: 0 },
          540_000,
        );

        return (await bound.execute!(args.input, {
          toolCallId: tc.toolCallId,
          messages: [],
          context: tc,
        })) as Value;
      }
    }
  },
});

export const events = queryGeneric({
  args: {},
  handler: (ctx) => ctx.db.query("events").take(100),
});
