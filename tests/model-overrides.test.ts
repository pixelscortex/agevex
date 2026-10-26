// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setup, api, state } from "./setup.js";
import { requireReceipt } from "./receipt.js";
import { getConvexSize } from "convex/values";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("every slice in a run keeps its model while a later send changes only the next run", async () => {
  const t = setup();
  const owner = t.withIdentity({ subject: "alice" });

  state.overrideTools = true;

  const first = await owner
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "first",
      requestKey: "first",
      models: { Main: "first" },
    })
    .then(requireReceipt);

  await owner.mutation(api.agents.send, {
    threadId: first.threadId,
    text: "second",
    requestKey: "second",
    models: { Main: "second" },
  });

  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  expect(state.overrideCalls).toEqual(["first", "first", "second"]);

  await owner.mutation(api.agents.send, {
    threadId: first.threadId,
    text: "inherit",
    requestKey: "inherit",
  });

  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  expect(state.overrideCalls).toEqual(["first", "first", "second", "second"]);

  await owner.mutation(api.agents.send, {
    threadId: first.threadId,
    text: "reset",
    requestKey: "reset",
    models: {},
  });

  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  expect(state.calls).toHaveLength(1);
});

it("descendant and result turns use their originating run's per-agent snapshot", async () => {
  const t = setup();
  const owner = t.withIdentity({ subject: "alice" });

  state.delegate = true;

  const first = await owner
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "delegate",
      requestKey: "first",
      models: { Researcher: "first" },
    })
    .then(requireReceipt);

  await owner.mutation(api.agents.send, {
    threadId: first.threadId,
    text: "later",
    requestKey: "later",
    models: { Researcher: "second" },
  });

  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  expect(state.overrideCalls).toEqual(["first", "second"]);
  expect(state.calls.length).toBeGreaterThanOrEqual(4);
});

it.each<Record<string, string>>([
  { Missing: "first" },
  { Main: "unlisted" },
  { Main: "x".repeat(201) },
])("unregistered models or agents are refused before saving a thread", async (models) => {
  const t = setup();
  const owner = t.withIdentity({ subject: "alice" });

  expect(
    await owner.mutation(api.agents.open, {
      agent: "Main",
      prompt: "hello",
      requestKey: "first",
      models,
    }),
  ).toEqual({ status: "rejected", code: "INVALID_MODELS" });
});

it("changing models under a reused request key is a conflict", async () => {
  const t = setup();
  const owner = t.withIdentity({ subject: "alice" });
  const args = { agent: "Main", prompt: "hello", requestKey: "first", models: { Main: "first" } };

  await owner.mutation(api.agents.open, args);

  expect(await owner.mutation(api.agents.open, { ...args, models: { Main: "second" } })).toEqual({
    status: "rejected",
    code: "KEY_CONFLICT",
  });
});

it("a 512-byte model map is accepted and a 513-byte map is refused before a native write", async () => {
  const t = setup(undefined, undefined, true);
  const owner = t.withIdentity({ subject: "alice" });
  const models = { Main: "😀".repeat(100), Researcher: "x".repeat(90) };

  expect(getConvexSize(models)).toBe(512);

  const first = await owner
    .mutation(api.agents.open, { agent: "Main", prompt: "first", requestKey: "first", models })
    .then(requireReceipt);

  const before = await owner.query(api.agents.messages, {
    threadId: first.threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

  expect(
    await owner.mutation(api.agents.send, {
      threadId: first.threadId,
      text: "oversize",
      requestKey: "oversize",
      models: { ...models, Researcher: "x".repeat(91) },
    }),
  ).toEqual({ status: "rejected", code: "INVALID_MODELS" });

  expect(
    await owner.query(api.agents.messages, {
      threadId: first.threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    }),
  ).toEqual(before);

  await owner.mutation(api.agents.cancel, { threadId: first.threadId });
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
});
