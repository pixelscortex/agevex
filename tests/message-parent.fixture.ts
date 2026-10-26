/** Fake native models and real Workflow lanes for child progress guarantees. */
import { convexTest } from "convex-test";
import native from "@convex-dev/agent/test";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { expect, vi } from "vite-plus/test";
import agevex from "../src/test.js";
import { Agent, registerAgent, type Registration, type SlotFacts } from "../src/client/index.js";
import schema from "./fixture/schema.js";
import { components, rawAssignment } from "./fixture/api.js";
import { coordinateReference, runTurnReference } from "./host.js";
import { main, reset, v2, v2api as api } from "./delegation-v2.host.js";
import { requireReceipt } from "./receipt.js";

const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

export const evidence: { facts: SlotFacts; key: string; usage: unknown }[] = [];

const charge = {
  key: "fake",
  attach: async () => {},
  correct: async () => {},
  settle: async () => {},
  get: async () => null,
};

/** Registration adds native approval/deferred tools only for boundary tests. */
function runtime(limits?: Registration["limits"], boundary?: "approval" | "deferred") {
  const tools: ToolSet = boundary
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
    : {};

  const root = new Agent(components.agent, {
    name: "Main",
    languageModel: main.textModel,
    subagents: main.subagents,
    tools,
  });

  return registerAgent(components.agevex, {
    agents: [root],
    title: false,
    limits,
    refs: { runTurn: runTurnReference, coordinate: coordinateReference },
    authorize: async (ctx, scope) => {
      if (scope.operation === "deliver" || scope.operation === "delegate") {
        if (scope.subject !== "alice") throw new Error("FORBIDDEN");

        return { subject: scope.subject };
      }

      const identity = await ctx.auth.getUserIdentity();

      if (!identity) throw new Error("FORBIDDEN");

      return { subject: identity.subject };
    },
    authorizeExecution: async () => {},
    usage: {
      scope: (_ctx, facts) => ({
        estimate: async () => charge,
        record: async (_provider, args) => {
          evidence.push({ facts, key: args.key, usage: args.usage });

          return charge;
        },
      }),
    },
  });
}

/** Enforce real transaction ceilings; callers can select every hard host maximum. */
export function setup(limits?: Registration["limits"], boundary?: "approval" | "deferred") {
  reset();
  evidence.length = 0;

  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: {
      ...modules,
      "./fixture/agents.ts": async () => {
        const rt = runtime(limits, boundary);

        return { ...rt.internalFunctions(), ...rt.authorizedEndpoints() };
      },
    },
  });

  native.register(t);
  agevex.register(t);

  return t;
}
export type Test = ReturnType<typeof setup>;
export const owner = (t: Test) => t.withIdentity({ subject: "alice" });
export const open = (t: Test) =>
  owner(t)
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "work",
      requestKey: "progress",
    })
    .then(requireReceipt);
export const calls = (name: string) => v2.calls.filter((entry) => entry.agent === name);
export const drain = (t: Test) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
export const tree = (t: Test, threadId: string) => owner(t).query(api.agents.runTree, { threadId });
export const transcript = (t: Test, threadId: string) =>
  owner(t).query(api.agents.messages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

/** Advance only a small clock slice, allowing in-flight fake models to remain held. */
export async function waitFor(t: Test, check: () => boolean | Promise<boolean>) {
  await expect
    .poll(async () => {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      return check();
    })
    .toBe(true);
}

/** A model gate proves parent progress independently of child completion. */
export function gate() {
  let release!: () => void;

  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

/** Use only the child's persisted assignment capability, never a model-selected parent. */
export async function sender(t: Test, threadId: string, index = 0) {
  const run = (await tree(t, threadId))[index];
  const row = (await t.query(rawAssignment, { assignmentId: run.childAssignmentId! }))!;

  return { assignmentId: row._id, turnToken: row.turnToken! };
}

/** An internal retry models a lost tool response without another model invocation. */
export const send = (
  t: Test,
  actor: Awaited<ReturnType<typeof sender>>,
  text: string,
  toolCallId: string = crypto.randomUUID(),
) => t.mutation(api.agents.coordinate, { op: "message_parent", ...actor, toolCallId, text });
export { api, components, rawAssignment };
