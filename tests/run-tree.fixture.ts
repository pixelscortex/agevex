/** Native fake models, real lanes, and an optional app usage view for tree guarantees. */
import { convexTest } from "convex-test";
import native from "@convex-dev/agent/test";
import {
  componentsGeneric,
  getFunctionAddress,
  type FunctionReference,
  type RegisteredAction,
} from "convex/server";
import { tool, type ToolSet } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { z } from "zod";
import { vi } from "vite-plus/test";
import { mark } from "../src/component/turns/tools.js";
import type { MutationCtx } from "../src/component/_generated/server.js";
import type { Id } from "../src/component/_generated/dataModel.js";
import agevex from "../src/test.js";
import {
  Agent,
  defineOnceTool,
  registerAgent,
  type Registration,
  type ManagedAgent,
  type TurnArgs,
} from "../src/client/index.js";
import type { RunnerCtx } from "../src/client/registration/context.js";
import { components } from "./fixture/api.js";
import schema from "./fixture/schema.js";
import { main, builder, reviewer, reset, v2api as api } from "./delegation-v2.host.js";
import { coordinateReference, runTurnReference } from "./host.js";
import { requireReceipt } from "./receipt.js";
import { gate } from "./message-parent.fixture.js";
import type * as seed from "./run-tree.seed.js";
import type { ApiFromModules } from "convex/server";

const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

type MarkerArgs = {
  assignmentId: Id<"assignments">;
  turnToken: string;
  sliceId?: string;
  key: string;
  name?: string;
};

// Convex 1.47 registration_impl.ts:263 attaches the handler; convex-test uses it.
const markerHandler = (
  mark as unknown as { _handler: (ctx: MutationCtx, args: MarkerArgs) => Promise<null> }
)._handler;

export const progress = {
  started: [] as string[],
  gates: new Map<string, ReturnType<typeof gate>>(),
};

/** A held local effect makes the public currentTool observable before completion. */
function tools(boundary?: "approval" | "ask") {
  return {
    write_card: defineOnceTool({
      name: "write_card",
      input: z.object({ label: z.string() }),
      run: async ({ label }) => {
        progress.started.push(label);
        await progress.gates.get(label)?.promise;

        return "written";
      },
    }),
    ...(boundary
      ? {
          human:
            boundary === "approval"
              ? tool({
                  inputSchema: z.object({}),
                  needsApproval: true,
                  execute: async () => "approved",
                })
              : tool({ inputSchema: z.object({}) }),
        }
      : {}),
  };
}

/** Hold an RPC before its transaction begins, preserving convex-test transaction isolation. */
function interceptMarkerRpc(
  action: RegisteredAction<"internal", TurnArgs, null>,
  intercept: NonNullable<Parameters<typeof setup>[0]>["markerRpc"],
  returned?: () => void,
) {
  const handler = (
    action as unknown as {
      _handler: (ctx: RunnerCtx, args: TurnArgs) => Promise<null>;
    }
  )._handler;

  const markerKey = JSON.stringify(getFunctionAddress(components.agevex.turns.tools.mark));

  return {
    ...action,
    _handler: async (ctx: RunnerCtx, args: TurnArgs) => {
      const result = await handler(
        {
          ...ctx,
          runMutation: (async (ref, payload) => {
            if (JSON.stringify(getFunctionAddress(ref)) === markerKey)
              await intercept?.(payload as MarkerArgs);

            return ctx.runMutation(ref, payload);
          }) as RunnerCtx["runMutation"],
        },
        args,
      );

      returned?.();

      return result;
    },
  };
}

export function setup(
  options: {
    usage?: Registration["usage"];
    limits?: Registration["limits"];
    boundary?: "approval" | "ask";
    marker?: (args: MarkerArgs) => Promise<void>;
    markerRpc?: (args: MarkerArgs) => Promise<void>;
    turnReturned?: () => void;
  } = {},
) {
  reset();
  progress.started = [];
  progress.gates.clear();

  const t = convexTest({
    schema,
    transactionLimits: { bytesRead: 8 << 20 },
    modules: {
      ...modules,
      "./fixture/agents.ts": async () => {
        const endpoints = runtime.authorizedEndpoints();

        const actions = runtime.internalFunctions();

        return {
          ...endpoints,
          ...actions,
          runTurn: interceptMarkerRpc(actions.runTurn, options.markerRpc, options.turnReturned),
        };
      },
    },
  });

  native.register(t);
  agevex.register(t);

  t.registerComponent("agevex", agevex.schema, {
    ...agevex.modules,
    "./component/treeSeed.ts": () => import("./run-tree.seed.js"),
    "./component/turns/tools.ts": async () => ({
      mark: {
        ...mark,
        _handler: async (ctx: MutationCtx, args: MarkerArgs) => {
          await options.marker?.(args);

          return markerHandler(ctx, args);
        },
      },
    }),
  });

  const child = new Agent<object, ToolSet>(components.agent, {
    name: "Builder",
    languageModel: builder.textModel as LanguageModelV4,
    subagents: [reviewer],
    tools: tools(),
  });

  const root = new Agent<object, ToolSet>(components.agent, {
    name: "Main",
    languageModel: main.textModel as LanguageModelV4,
    subagents: [child as ManagedAgent, reviewer],
    tools: tools(options.boundary),
  });

  const runtime = registerAgent(components.agevex, {
    title: false,
    limits: options.limits,
    agents: [root],
    refs: { runTurn: runTurnReference, coordinate: coordinateReference },
    usage: options.usage,
    authorize: async (ctx, scope) => {
      if (scope.operation === "delegate" || scope.operation === "deliver")
        return { subject: scope.subject };

      const identity = await ctx.auth.getUserIdentity();

      if (!identity) throw new Error("FORBIDDEN");

      return { subject: identity.subject };
    },
    authorizeExecution: async () => {},
  });

  return { t };
}

type Seed = ApiFromModules<{ treeSeed: typeof seed }>["treeSeed"];
export const fixture = componentsGeneric().agevex.treeSeed as unknown as {
  [K in keyof Seed]: Seed[K] extends FunctionReference<infer T, infer V, infer A, infer R>
    ? FunctionReference<T, V, Omit<A, "assignmentId"> & { assignmentId?: string }, R>
    : never;
};
export type Test = ReturnType<typeof setup>["t"];
export const owner = (t: Test) => t.withIdentity({ subject: "alice" });
export const open = (t: Test, prompt = "work", requestKey = crypto.randomUUID()) =>
  owner(t).mutation(api.agents.open, { agent: "Main", prompt, requestKey }).then(requireReceipt);
export const read = (t: Test, threadId: string, rootRunId?: string) =>
  owner(t).query(api.agents.runTree, { threadId, rootRunId });
export const drain = (t: Test) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
export { api, gate };
