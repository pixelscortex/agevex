// @vitest-environment edge-runtime
import { it, expect, vi, afterEach, beforeEach } from "vite-plus/test";
import { setup, api, internal, components, state } from "./setup.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const input = { agent: "Main", prompt: "first boundary", requestKey: "first" };
const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));

// Phase 1a unifies request-key errors with the general ledger.
it("deduplicates open/send and conflicts before a native write", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await alice.mutation(api.agents.open, input);
  expect(await alice.mutation(api.agents.open, input)).toEqual(receipt);
  await expect(alice.mutation(api.agents.open, { ...input, prompt: "changed" })).rejects.toThrow(
    "KEY_CONFLICT",
  );
  const send = { threadId: receipt.threadId, text: "second boundary", requestKey: "second" };
  const second = await alice.mutation(api.agents.send, send);
  expect(await alice.mutation(api.agents.send, send)).toEqual(second);
  await expect(alice.mutation(api.agents.send, { ...send, text: "changed" })).rejects.toThrow(
    "KEY_CONFLICT",
  );
  await expect(alice.mutation(api.agents.send, { ...send, requestKey: "first" })).rejects.toThrow(
    "KEY_CONFLICT",
  );
  const messages = await alice.query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(messages.page.map((m) => m.text).sort()).toEqual(["first boundary", "second boundary"]);
});

it("queues busy/concurrent arrivals, anchors prompts and wakes after idle", async () => {
  vi.useFakeTimers();
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await alice.mutation(api.agents.open, input);
  await Promise.all(
    ["later two", "later three"].map((text, i) =>
      alice.mutation(api.agents.send, {
        threadId: receipt.threadId,
        text,
        requestKey: `later${i}`,
      }),
    ),
  );
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "queued",
    queuedMessages: 2,
  });
  await drain(t);
  expect(state.calls).toHaveLength(3);
  expect(JSON.stringify(state.calls[0].prompt)).toContain("first boundary");
  expect(JSON.stringify(state.calls[0].prompt)).not.toContain("later two");
  expect(JSON.stringify(state.calls[0].prompt)).not.toContain("later three");
  expect(state.calls.every((call) => call.maxOutputTokens === 4096)).toBe(true);
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "wake idle",
    requestKey: "idle",
  });
  await drain(t);
  expect(state.calls).toHaveLength(4);
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    assignmentStatus: "open",
  });
});

it("duplicate dispatch/finalization and stale tokens never take ownership", async () => {
  vi.useFakeTimers();
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await alice.mutation(api.agents.open, input);
  const args = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:0` };
  await t.action(internal.agents.runTurn, { ...args, turnToken: "stale" });
  await Promise.all([t.action(internal.agents.runTurn, args), vi.advanceTimersByTimeAsync(100)]);
  await t.action(internal.agents.runTurn, args);
  await t.mutation(components.agevex.queue.finish, { ...args, errorCode: null });
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
  });
});

it("generation failure is sanitized, blocks sends and never retries", async () => {
  vi.useFakeTimers();
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  state.fail = true;
  const receipt = await alice.mutation(api.agents.open, input);
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "GENERATION_FAILED",
    assignmentStatus: "open",
  });
  const before = await alice.query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  await expect(
    alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "must rollback",
      requestKey: "blocked",
    }),
  ).rejects.toThrow("RECOVERY_REQUIRED");
  const after = await alice.query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(after.page).toEqual(before.page);
  expect(await alice.mutation(api.agents.open, input)).toEqual(receipt);
});

it("finalization failure becomes ambiguous without replaying native generation", async () => {
  vi.useFakeTimers();
  const t = setup("finish");
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await alice.mutation(api.agents.open, input);
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "EXECUTION_AMBIGUOUS",
  });
  await t.action(internal.agents.runTurn, {
    assignmentId: receipt.assignmentId,
    turnToken: `${receipt.assignmentId}:0`,
  });
  expect(state.calls).toHaveLength(1);
});

it("stalled detection blocks an owner rather than stealing or replaying it", async () => {
  vi.useFakeTimers();
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await alice.mutation(api.agents.open, input);
  const args = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:0` };
  expect(await t.mutation(components.agevex.queue.claim, args)).not.toBeNull();
  await vi.advanceTimersByTimeAsync(120_000);
  await drain(t);
  expect(state.calls).toHaveLength(0);
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "EXECUTION_AMBIGUOUS",
  });
  await t.mutation(components.agevex.queue.finish, { ...args, errorCode: null });
  expect(await t.mutation(components.agevex.queue.claim, args)).toBeNull();
});
