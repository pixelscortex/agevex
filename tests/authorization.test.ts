// @vitest-environment edge-runtime
import { requireReceipt } from "./receipt.js";
import { it, expect, vi, afterEach, beforeEach } from "vite-plus/test";
import { setup, api, state, components } from "./setup.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
it("requires trusted host authorization for writes and native reads", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const bob = t.withIdentity({ subject: "bob" });
  await expect(
    t
      .mutation(api.agents.open, { agent: "Main", prompt: "hello", requestKey: "x" })
      .then(requireReceipt),
  ).rejects.toThrow("UNAUTHENTICATED");
  const receipt = await alice
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "private",
      requestKey: "x",
    })
    .then(requireReceipt);
  await expect(
    bob.mutation(api.agents.send, { threadId: receipt.threadId, text: "bad", requestKey: "b" }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    bob.query(api.agents.messages, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(bob.query(api.agents.activity, { threadId: receipt.threadId })).rejects.toThrow(
    "FORBIDDEN",
  );
});

it("rechecks revoked execution scope without making a model call", async () => {
  vi.useFakeTimers();
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await alice
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "hi",
      requestKey: "x",
    })
    .then(requireReceipt);
  state.revoke = true;
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  expect(state.calls).toHaveLength(0);
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "AUTHORIZATION_DENIED",
    assignmentStatus: "open",
  });
});

it.each(["save", "accept"] as const)("rolls native writes back if %s fails", async (fault) => {
  const t = setup(fault);
  const alice = t.withIdentity({ subject: "alice" });
  await expect(
    alice
      .mutation(api.agents.open, { agent: "Main", prompt: "hi", requestKey: "x" })
      .then(requireReceipt),
  ).rejects.toThrow("injected failure");
  const threads = await t.query(components.agent.threads.listThreadsByUserId, { userId: "alice" });
  expect(threads.page).toHaveLength(0);
});
