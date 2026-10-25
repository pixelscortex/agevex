// @vitest-environment edge-runtime
import { requireReceipt } from "./receipt.js";
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { setup, api, internal, components, state } from "./setup.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const input = { agent: "Main", prompt: "bounded", requestKey: "first" };

const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));

// Phase 1a executes bounded slices until tools finish or a child handoff occurs.
it("continues a native tool step in a separate bounded slice", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });

  state.tools = true;
  const receipt = await alice.mutation(api.agents.open, input).then(requireReceipt);

  await drain(t);
  expect(state.calls).toHaveLength(2);

  const messages = await alice.query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });

  expect(JSON.stringify(messages)).toContain("echoed");
  expect(JSON.stringify(messages)).not.toContain("MUST NOT RUN");

  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    assignmentStatus: "open",
  });
});

it("queues while running and wakes transactionally without losing a busy arrival", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });

  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });

  const receipt = await alice.mutation(api.agents.open, input).then(requireReceipt);

  const running = t.action(internal.agents.runTurn, {
    assignmentId: receipt.assignmentId,
    turnToken: `${receipt.assignmentId}:0`,
  });

  await vi.advanceTimersByTimeAsync(100);
  expect(state.calls).toHaveLength(1);

  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "while running",
    requestKey: "busy",
  });

  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "running",
    queuedMessages: 1,
  });

  state.release!();
  await vi.advanceTimersByTimeAsync(100);
  await running;
  await drain(t);
  expect(state.calls).toHaveLength(2);

  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
  });
});

it("serializes a finish versus arrival race into exactly one next owner", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await alice.mutation(api.agents.open, input).then(requireReceipt);
  const args = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:0` };

  await t.mutation(components.agevex.turns.slices.claim, args);

  await Promise.all([
    t.mutation(components.agevex.turns.slices.finish, { ...args, errorCode: null }),
    alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "racing arrival",
      requestKey: "racing",
    }),
  ]);

  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(JSON.stringify(state.calls[0].prompt)).toContain("racing arrival");

  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
  });
});

it("aborts a non-finishing provider at 90 seconds and does not retry", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });

  state.hang = true;
  const receipt = await alice.mutation(api.agents.open, input).then(requireReceipt);

  const running = t.action(internal.agents.runTurn, {
    assignmentId: receipt.assignmentId,
    turnToken: `${receipt.assignmentId}:0`,
  });

  await vi.advanceTimersByTimeAsync(100);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].abortSignal?.aborted).toBe(false);

  // An action supplies syscall scope without a transaction around reconciliation.
  await t.action(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });

  await running;
  expect(state.calls[0].abortSignal?.aborted).toBe(true);
  await drain(t);
  expect(state.calls).toHaveLength(1);

  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "GENERATION_FAILED",
  });
});
