/** App-owned store/fetch convention; all coordination uses real agevex/Agent lanes. */
import { convexTest } from "convex-test";
import native from "@convex-dev/agent/test";
import {
  defineSchema,
  defineTable,
  componentsGeneric,
  type ApiFromModules,
  internalMutationGeneric,
  internalQueryGeneric,
  makeFunctionReference,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { z } from "zod";
import {
  Agent,
  defineOnceTool,
  registerAgent,
  type ManagedAgent,
  type SlotFacts,
  type UsageSlot,
} from "../../src/client/index.js";
import { createAskUserTool } from "../../src/modules/tools/client/index.js";
import agevex from "../../src/test.js";
import meterTest from "../../src/modules/meter/test.js";
import { defineMeter } from "../../src/modules/meter/client/index.js";
import { main, builder, reviewer, reset } from "../delegation-v2.host.js";
import { components } from "../fixture/api.js";
import { runTurnReference, coordinateReference } from "../host.js";

const APP_LIMITS = { bodyChars: 2000 };
const schema = defineSchema({ work: defineTable({ subject: v.string(), body: v.string() }) });

const storeRef = makeFunctionReference<
  "mutation",
  { subject: string; body: string },
  { id: string }
>("work:store");

const fetchRef = makeFunctionReference<"query", { subject: string; id: string }, { body: string }>(
  "work:fetch",
);

export const store = internalMutationGeneric({
  args: { subject: v.string(), body: v.string() },
  returns: v.object({ id: v.string() }),
  handler: async (ctx, args) => {
    if (args.body.length > APP_LIMITS.bodyChars) throw new Error("WORK_TOO_LARGE");

    return { id: await ctx.db.insert("work", args) };
  },
});
export const fetch = internalQueryGeneric({
  args: { subject: v.string(), id: v.string() },
  returns: v.object({ body: v.string() }),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("work", args.id);
    const row = id ? await ctx.db.get("work", id) : null;

    if (!row || row.subject !== args.subject) throw new ConvexError({ code: "FORBIDDEN" });

    return { body: row.body };
  },
});

const storeWork = defineOnceTool({
  name: "store_work",
  input: z.object({ body: z.string().max(APP_LIMITS.bodyChars) }),
  run: (input, tc) => tc.ctx.runMutation(storeRef, { ...input, subject: tc.subject }),
});

const fetchWork = defineOnceTool({
  name: "fetch_work",
  input: z.object({ id: z.string() }),
  run: (input, tc) => tc.ctx.runQuery(fetchRef, { ...input, subject: tc.subject }),
});

export const evidence: { facts: SlotFacts; key: string; usage: unknown }[] = [];

/** No app tool trusts a model-supplied owner. Children inherit trusted subject facts. */
function runtime(usage: UsageSlot) {
  const review: ManagedAgent = new Agent(components.agent, {
    name: "Reviewer",
    languageModel: reviewer.textModel,
    tools: { fetch_work: fetchWork, ask_user: createAskUserTool() },
  });

  const build: ManagedAgent = new Agent(components.agent, {
    name: "Builder",
    languageModel: builder.textModel,
    subagents: [review],
    tools: { store_work: storeWork },
  });

  const root = new Agent(components.agent, {
    name: "Main",
    languageModel: main.textModel,
    // Main may delegate Reviewer, but only Builder owns the run it launches.
    subagents: [build, review],
    tools: { ask_user: createAskUserTool() },
  });

  return registerAgent(components.agevex, {
    agents: [root],
    title: false,
    refs: { runTurn: runTurnReference, coordinate: coordinateReference },
    authorize: async (ctx, scope) => {
      if (scope.operation === "delegate" || scope.operation === "deliver")
        return { subject: scope.subject };

      const identity = await ctx.auth.getUserIdentity();

      if (!identity) throw new Error("FORBIDDEN");

      return { subject: identity.subject };
    },
    authorizeExecution: async (_ctx, scope) => {
      if (scope.subject !== "alice") throw new Error("FORBIDDEN");
    },
    usage: {
      ...usage,
      scope: (ctx, facts) => {
        const backend = usage.scope(ctx, facts);

        return {
          ...backend,
          record: async (provider, args) => {
            evidence.push({ facts, key: args.key, usage: args.usage });

            return backend.record(provider, args);
          },
        };
      },
    },
  });
}

export function setup() {
  reset();
  evidence.length = 0;

  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: {
      "./fixture/_generated/api.js": () => import("../fixture/_generated/api.js"),
      "./fixture/agents.ts": async () => {
        const rt = runtime(meter.usageSlot());

        return { ...rt.internalFunctions(), ...rt.authorizedEndpoints() };
      },
      "./fixture/work.ts": async () => ({ store, fetch }),
    },
  });

  native.register(t);
  agevex.register(t);

  const meter = defineMeter(meterTest.register(t), {
    providers: {
      "mock-provider": { inline: () => ({ usd: 0.01 }), estimate: () => ({ usd: 0.005 }) },
    },
  });

  t.registerComponent("agevex", agevex.schema, {
    ...agevex.modules,
    "./component/acceptanceFixture.ts": () => import("./node.fixture.js"),
  });

  return t;
}

export const node = (
  componentsGeneric().agevex as unknown as {
    acceptanceFixture: ApiFromModules<{ node: typeof import("./node.fixture.js") }>["node"];
  }
).acceptanceFixture.assignment;
