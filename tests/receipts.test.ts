// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setup, api } from "./setup.js";
import { requireReceipt } from "./receipt.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("accepted and duplicate receipts retain the original zero-based inbox position after the queue drains", async () => {
  const t = setup();
  const owner = t.withIdentity({ subject: "alice" });
  const input = { agent: "Main", prompt: "start", requestKey: "start" };
  const first = await owner.mutation(api.agents.open, input).then(requireReceipt);
  expect(first).toMatchObject({ status: "accepted", position: 0 });
  const send = { threadId: first.threadId, text: "queued", requestKey: "queued" };
  await owner.mutation(api.agents.send, { ...send, requestKey: "ahead" });
  const queued = await owner.mutation(api.agents.send, send);
  expect(queued).toMatchObject({ status: "accepted", position: 1 });
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  expect(await owner.mutation(api.agents.open, input)).toEqual({ ...first, status: "duplicate" });
  expect(await owner.mutation(api.agents.send, send)).toEqual({ ...queued, status: "duplicate" });
});

it("queue-full refusal saves no prompt and duplicate admission succeeds even at the hard maximum", async () => {
  const t = setup(undefined, { queueLength: 100 }, true);
  const owner = t.withIdentity({ subject: "alice" });
  const first = await owner
    .mutation(api.agents.open, { agent: "Main", prompt: "start", requestKey: "start" })
    .then(requireReceipt);
  const send = { threadId: first.threadId, text: "queued", requestKey: "q0" };
  const original = await owner.mutation(api.agents.send, send);
  for (let i = 1; i < 100; i++)
    await owner.mutation(api.agents.send, { ...send, requestKey: `q${i}` });
  const before = await owner.query(api.agents.messages, {
    threadId: first.threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });
  expect(
    await owner.mutation(api.agents.send, { ...send, requestKey: "overflow", text: "unsaved" }),
  ).toEqual({ status: "rejected", code: "QUEUE_FULL" });
  expect(await owner.mutation(api.agents.send, send)).toEqual({ ...original, status: "duplicate" });
  expect(
    await owner.query(api.agents.messages, {
      threadId: first.threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    }),
  ).toEqual(before);
  await owner.mutation(api.agents.cancel, { threadId: first.threadId });
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
});

it.each([
  [{ prompt: " " }, "INVALID_MESSAGE"],
  [{ prompt: "x".repeat(16_001) }, "INVALID_MESSAGE"],
  [{ requestKey: "" }, "INVALID_REQUEST_KEY"],
  [{ requestKey: "x".repeat(201) }, "INVALID_REQUEST_KEY"],
  [{ agent: "missing" }, "UNKNOWN_AGENT"],
] as const)(
  "expected invalid open input returns %s without bypassing authorization",
  async (change, code) => {
    const t = setup();
    const input = { agent: "Main", prompt: "hello", requestKey: "key", ...change };
    expect(await t.withIdentity({ subject: "alice" }).mutation(api.agents.open, input)).toEqual({
      status: "rejected",
      code,
    });
    await expect(t.mutation(api.agents.open, input)).rejects.toThrow("UNAUTHENTICATED");
  },
);
