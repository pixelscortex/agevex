import {
  internalActionGeneric,
  queryGeneric,
  componentsGeneric,
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";
import { v, type Value } from "convex/values";
import type { Tool } from "ai";
import type { AgentComponent } from "@convex-dev/agent";
import { bindOnceTool, type ToolContext } from "../../../src/client/once.js";
import type { ComponentApi as CoreApi } from "../../../src/component/_generated/component.js";
import { defineSandbox } from "../../../src/sandbox/index.js";
import type { ComponentApi } from "../../../src/sandbox/component/_generated/component.js";
import type { SandboxLimits } from "../../../src/sandbox/limits.js";
import type {
  PollArgs,
  SettleArgs,
  SandboxJobEvent,
  SandboxUsageEvent,
} from "../../../src/sandbox/types.js";
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
  callbackFails: false,
  usageFails: false,
  usage: [] as SandboxUsageEvent[],
  resolver: undefined as undefined | { subject: string; threadId: string; runId: string },
  instance: undefined as undefined | ReturnType<typeof defineSandbox>,
};

export function runtime() {
  const sandbox = defineSandbox({
    component: components.sandbox,
    provider: state.fake.provider,
    scope: state.scope,
    limits: state.limits,
    agent: components.agent,
    refs: {
      poll: () => ref<"action", PollArgs>("poll"),
      settle: () => ref<"mutation", SettleArgs>("settle"),
      cleanup: () => ref<"action", Record<string, never>>("cleanup"),
    },
    authorize: async (_ctx, request) => {
      if (!state.authorized) throw new Error("HOST_DENIED");
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
  });
  state.instance = sandbox;
  return sandbox.internalFunctions();
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
