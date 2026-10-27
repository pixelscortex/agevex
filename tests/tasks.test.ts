// @vitest-environment edge-runtime
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { mockModel } from "@convex-dev/agent";
import { z } from "zod";
import agevex from "../src/test.js";
import {
  defineTask,
  runTask,
  type SlotFacts,
  type UsageEvent,
  type TaskOptions,
} from "../src/client/index.js";
import { components } from "./fixture/api.js";
import schema from "./fixture/schema.js";
import { fingerprint } from "../src/client/once.js";
const sdk = vi.hoisted(() => ({ deprecatedUnavailable: false }));

vi.mock("ai", async (original) => {
  const actual = await original<typeof import("ai")>();

  return {
    ...actual,
    generateObject: (...args: Parameters<typeof actual.generateObject>) => {
      if (sdk.deprecatedUnavailable) throw new Error("generateObject is unavailable");

      return actual.generateObject(...args);
    },
  };
});

import { fixture, reset, registration, exports, api } from "./hooks.host.js";
import { requireReceipt } from "./receipt.js";
const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

function setup() {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: { ...modules, "./fixture/agents.ts": async () => exports() },
  });

  agent.register(t);
  agevex.register(t);

  return t;
}

const attribution: SlotFacts = {
  subject: "alice",
  rootThreadId: "thread",
  threadId: "thread",
  runId: "run",
  agent: "Main",
};

const options = { component: components.agevex, attribution, key: "request" } satisfies TaskOptions;

function counted(model: ReturnType<typeof mockModel>) {
  const calls: Parameters<typeof model.doGenerate>[0][] = [];
  const generate = model.doGenerate.bind(model);

  model.doGenerate = (args) => {
    calls.push(args);

    return generate(args);
  };

  return Object.assign(model, { calls });
}
function task(outputs: string[], repair?: 0 | 1) {
  const model = counted(
    mockModel({ contentSteps: outputs.map((text) => [{ type: "text", text }]) }),
  );

  const definition = defineTask({
    name: "classify",
    input: z.object({ text: z.string() }),
    output: z.object({ category: z.enum(["yes", "no"]) }),
    prompt: ({ text }) => `Classify: ${text}`,
    model,
    repair,
  });

  return { model, definition };
}

beforeEach(() => {
  reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("defineTask repairs invalid structured output exactly once", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"invalid"}', '{"category":"yes"}']);
  const result = await t.action((ctx) => runTask(ctx, definition, { text: "hello" }, options));

  expect(result).toEqual({ status: "done", value: { category: "yes" } });
  expect(model.calls).toHaveLength(2);
  expect(JSON.stringify(model.calls[1].prompt)).toContain("previous response");
});

it("task instructions are sent as the system message, separate from the user prompt, on every attempt", async () => {
  const t = setup();

  const model = counted(
    mockModel({
      contentSteps: [
        [{ type: "text", text: '{"category":"invalid"}' }],
        [{ type: "text", text: '{"category":"yes"}' }],
      ],
    }),
  );

  const definition = defineTask({
    name: "classify",
    input: z.object({ text: z.string() }),
    output: z.object({ category: z.enum(["yes", "no"]) }),
    instructions: ({ text }) => `Be terse about ${text}.`,
    prompt: ({ text }) => `Classify: ${text}`,
    model,
  });

  const result = await t.action((ctx) => runTask(ctx, definition, { text: "hello" }, options));

  expect(result).toEqual({ status: "done", value: { category: "yes" } });
  expect(model.calls).toHaveLength(2);

  for (const call of model.calls) {
    const system = call.prompt.filter((message) => message.role === "system");
    const users = call.prompt.filter((message) => message.role === "user");

    expect(system).toEqual([{ role: "system", content: "Be terse about hello." }]);
    expect(users).toHaveLength(1);
    expect(JSON.stringify(users[0].content)).toContain("Classify: hello");
    expect(JSON.stringify(users[0].content)).not.toContain("Be terse");
  }
});

it("a task without instructions sends no system message", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"yes"}']);

  await t.action((ctx) => runTask(ctx, definition, { text: "hello" }, options));

  expect(model.calls).toHaveLength(1);
  expect(model.calls[0].prompt.some((message) => message.role === "system")).toBe(false);
});

it("task instructions are bounded like the prompt before any receipt or paid work", async () => {
  const t = setup();

  const model = counted(
    mockModel({ contentSteps: [[{ type: "text", text: '{"category":"yes"}' }]] }),
  );

  const define = (instructions: string) =>
    defineTask({
      name: "classify",
      input: z.string(),
      output: z.object({ category: z.string() }),
      instructions,
      prompt: (text) => text,
      model,
    });

  for (const instructions of [" ", "x".repeat(101)])
    await expect(
      t.action((ctx) =>
        runTask(ctx, define(instructions), "hello", { ...options, maxPromptLength: 100 }),
      ),
    ).rejects.toThrow("INVALID_TASK_INSTRUCTIONS");

  expect(model.calls).toHaveLength(0);
});

it("a second invalid output is terminal and replay cannot buy another repair", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"invalid"}']);
  const invoke = () => t.action((ctx) => runTask(ctx, definition, { text: "hello" }, options));

  expect(await invoke()).toEqual({ status: "failed", code: "INVALID_OUTPUT" });
  expect(await invoke()).toEqual({ status: "failed", code: "INVALID_OUTPUT" });
  expect(model.calls).toHaveLength(2);
});

it("a task replay returns its stored typed result and records each paid attempt once", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"no"}']);
  const charges: unknown[] = [];

  const usage = {
    record: async (_ctx: unknown, event: UsageEvent) => {
      charges.push({ provider: event.provider, args: event, facts: event });
    },
  };

  const invoke = () =>
    t.action((ctx) =>
      registration().runTask(ctx, definition, { text: "hello" }, { ...options, usage }),
    );

  // Standalone runTask also accepts a host-supplied custom usage slot.
  const first = await t.action((ctx) =>
    runTask(ctx, definition, { text: "hello" }, { ...options, usage }),
  );

  expect(await invoke()).toEqual(first);
  expect(first).toEqual({ status: "done", value: { category: "no" } });
  expect(model.calls).toHaveLength(1);
  expect(charges).toHaveLength(1);
  expect(charges[0]).toMatchObject({ facts: attribution });
});

it("an expired task lease becomes unknown without calling the model again", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"yes"}']);
  const parsed = { text: "hello" };
  const prompt = definition.prompt(parsed);

  await t.mutation(components.agevex.receipts.effects.begin, {
    scope: `task:${await fingerprint([attribution.subject, attribution.threadId, definition.name])}`,
    key: options.key,
    fingerprint: await fingerprint([parsed, prompt, [model.provider, model.modelId]]),
    leaseMs: 1,
  });

  vi.advanceTimersByTime(2);

  expect(await t.action((ctx) => runTask(ctx, definition, parsed, options))).toEqual({
    status: "unknown",
  });

  expect(model.calls).toHaveLength(0);
});

it("a task finishing after its lease expires reports unknown instead of a discarded result", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"yes"}']);
  const generate = model.doGenerate.bind(model);

  model.doGenerate = (args) => {
    vi.advanceTimersByTime(2);

    return generate(args);
  };

  expect(
    await t.action((ctx) =>
      runTask(ctx, definition, { text: "hello" }, { ...options, leaseMs: 1 }),
    ),
  ).toEqual({ status: "unknown" });

  expect(await t.action((ctx) => runTask(ctx, definition, { text: "hello" }, options))).toEqual({
    status: "unknown",
  });

  expect(model.calls).toHaveLength(1);
});

it("transport failures are not automatically retried or repaired", async () => {
  const t = setup();
  const model = counted(mockModel({ fail: true }));

  const definition = defineTask({
    name: "network",
    input: z.string(),
    output: z.object({ category: z.string() }),
    prompt: (text) => text,
    model,
  });

  const result = await t.action((ctx) => runTask(ctx, definition, "hello", options));

  expect(result).toEqual({ status: "unknown" });

  expect(await t.action((ctx) => runTask(ctx, definition, "hello", options))).toEqual({
    status: "unknown",
  });

  expect(model.calls).toHaveLength(1);
});

it("hooks can run an attributed task with the managed receipts and no extra workflow steps", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"yes"}']);
  let result: unknown;

  fixture.hooks.beforeTurn = async (hc) => {
    result = await runTask(hc, definition, { text: "hello" }, { key: "hook" });
  };

  const receipt = await t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.open, { agent: "Main", prompt: "hello", requestKey: "hook" })
    .then(requireReceipt);

  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
  expect(result).toEqual({ status: "done", value: { category: "yes" } });
  expect(model.calls).toHaveLength(1);

  expect(
    (
      await t
        .withIdentity({ subject: "alice" })
        .query(api.agents.activity, { threadId: receipt.threadId })
    ).errorCode,
  ).toBeNull();
});

it("task input and attribution validation happen before paid work or receipt admission", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"yes"}']);

  await expect(
    t.action((ctx) => runTask(ctx, definition, { text: 1 } as never, options)),
  ).rejects.toThrow();

  await expect(
    t.action((ctx) =>
      runTask(
        ctx,
        definition,
        { text: "hello" },
        { ...options, attribution: { subject: "alice" } as SlotFacts },
      ),
    ),
  ).rejects.toThrow("INVALID_TASK_ATTRIBUTION");

  expect(model.calls).toHaveLength(0);
});

it("an expired task lease prevents a paid repair re-ask", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"invalid"}', '{"category":"yes"}']);
  const generate = model.doGenerate.bind(model);

  model.doGenerate = (args) => {
    vi.advanceTimersByTime(2);

    return generate(args);
  };

  expect(
    await t.action((ctx) =>
      runTask(ctx, definition, { text: "hello" }, { ...options, leaseMs: 1 }),
    ),
  ).toEqual({ status: "unknown" });

  expect(model.calls).toHaveLength(1);
});

it("structured tasks work when deprecated generateObject is unavailable", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"invalid"}', '{"category":"yes"}']);

  sdk.deprecatedUnavailable = true;

  try {
    const invoke = () => t.action((ctx) => runTask(ctx, definition, { text: "hello" }, options));

    expect(await invoke()).toEqual({ status: "done", value: { category: "yes" } });
    expect(await invoke()).toEqual({ status: "done", value: { category: "yes" } });
    expect(model.calls).toHaveLength(2);
  } finally {
    sdk.deprecatedUnavailable = false;
  }
});

it("hook task defaults replay within a turn and a second run gets a fresh result", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"yes"}', '{"category":"no"}']);
  const results: unknown[] = [];

  fixture.hooks.beforeTurn = async (hc) => {
    results.push(await runTask(hc, definition, { text: "hello" }));
    results.push(await runTask(hc, definition, { text: "hello" }));
  };

  const user = t.withIdentity({ subject: "alice" });

  const r = await user
    .mutation(api.agents.open, { agent: "Main", prompt: "hello", requestKey: "first" })
    .then(requireReceipt);

  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);

  await user.mutation(api.agents.send, {
    threadId: r.threadId,
    text: "again",
    requestKey: "second",
  });

  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);

  expect(results).toEqual([
    { status: "done", value: { category: "yes" } },
    { status: "done", value: { category: "yes" } },
    { status: "done", value: { category: "no" } },
    { status: "done", value: { category: "no" } },
  ]);

  expect(model.calls).toHaveLength(2);
});

it.each(["subject", "agent", "rootThreadId", "threadId", "runId"] as const)(
  "host task rejects facts over 128 UTF-8 bytes before paid work: %s",
  async (fact) => {
    const t = setup();
    const { model, definition } = task(['{"category":"yes"}']);

    await expect(
      t.action((ctx) =>
        runTask(
          ctx,
          definition,
          { text: "hello" },
          { ...options, attribution: { ...attribution, [fact]: "😀".repeat(40) } },
        ),
      ),
    ).rejects.toThrow("INVALID_TASK_ATTRIBUTION");

    expect(model.calls).toHaveLength(0);
  },
);

it("refused dispatch records no usage and replays a failed receipt without paid work", async () => {
  const t = setup();
  const { model, definition } = task(['{"category":"yes"}']);

  const scope = vi.fn(() => {
    throw new Error("a refused dispatch must not reach the usage hook");
  });

  const beforeDispatch = vi.fn(async () => {
    throw new Error("TEXT_INACTIVE");
  });

  const invoke = () =>
    t.action((ctx) =>
      runTask(
        ctx,
        definition,
        { text: "hello" },
        {
          ...options,
          usage: { record: scope },
          beforeDispatch,
        },
      ),
    );

  expect(await invoke()).toEqual({ status: "failed", code: "TASK_FAILED" });
  expect(await invoke()).toEqual({ status: "failed", code: "TASK_FAILED" });
  expect(beforeDispatch).toHaveBeenCalledTimes(1);
  expect(model.calls).toHaveLength(0);
  expect(scope).not.toHaveBeenCalled();

  expect(
    await t.action((ctx) =>
      runTask(ctx, definition, { text: "hello" }, { ...options, key: "fresh" }),
    ),
  ).toEqual({ status: "done", value: { category: "yes" } });

  expect(model.calls).toHaveLength(1);
});
