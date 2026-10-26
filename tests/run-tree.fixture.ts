/** Native fake models, real lanes, and an optional real meter for tree guarantees. */
import { convexTest } from "convex-test";
import native from "@convex-dev/agent/test";
import { componentsGeneric, type FunctionReference } from "convex/server";
import { tool, type ToolSet } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { z } from "zod";
import { vi } from "vite-plus/test";
import { mark } from "../src/component/turns/tools.js";
import type { MutationCtx } from "../src/component/_generated/server.js";
import type { Id } from "../src/component/_generated/dataModel.js";
import agevex from "../src/test.js";
import meterTest from "../src/modules/meter/test.js";
import { defineMeter } from "../src/modules/meter/client/index.js";
import {
  Agent,
  defineOnceTool,
  registerAgent,
  type Registration,
  type ManagedAgent,
} from "../src/client/index.js";
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

export function setup(
  options: {
    meter?: boolean;
    limits?: Registration["limits"];
    boundary?: "approval" | "ask";
    marker?: (args: MarkerArgs) => Promise<void>;
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

        return { ...endpoints, ...runtime.internalFunctions() };
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

  const meterComponent = meterTest.register(t);

  const meter = defineMeter(meterComponent, {
    providers: {
      fake: {
        inline: () => ({ usd: 0.01 }),
        estimate: () => ({ usd: 0.005 }),
      },
    },
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
    usage: options.meter ? meter.usageSlot() : undefined,
    authorize: async (ctx, scope) => {
      if (scope.operation === "delegate" || scope.operation === "deliver")
        return { subject: scope.subject };

      const identity = await ctx.auth.getUserIdentity();

      if (!identity) throw new Error("FORBIDDEN");

      return { subject: identity.subject };
    },
    authorizeExecution: async () => {},
  });

  return { t, meter, meterComponent };
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
