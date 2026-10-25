// @vitest-environment edge-runtime
import { requireReceipt } from "./receipt.js";
import { it, expect, vi, afterEach } from "vite-plus/test";
import { listUIMessages } from "@convex-dev/agent";
import { setup, api, components } from "./setup.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("preserves native UI pagination/parts and native persisted stream deltas", async () => {
  vi.useFakeTimers();
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });

  const receipt = await alice
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "hello native",
      requestKey: "native",
    })
    .then(requireReceipt);

  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  const args = { threadId: receipt.threadId, paginationOpts: { cursor: null, numItems: 1 } };
  const wrapped = await alice.query(api.agents.messages, args);
  const native = await t.run((ctx) => listUIMessages(ctx, components.agent, args));

  // The server adds origin metadata while preserving native pagination/parts.
  expect(wrapped).toEqual({
    ...native,
    page: native.page.map((message) => ({ ...message, origin: "user" })),
  });

  expect(wrapped.page[0].parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "DEMO deterministic native reply" }),
  );

  const streams = await t.query(components.agent.streams.list, {
    threadId: receipt.threadId,
    statuses: ["finished"],
  });

  expect(streams).toHaveLength(1);
  const cursors = [{ streamId: streams[0].streamId, cursor: 0 }];

  const messages = await alice.query(api.agents.streams, {
    threadId: receipt.threadId,
    streamArgs: { kind: "deltas", cursors },
  });

  const deltas = await t.query(components.agent.streams.listDeltas, {
    threadId: receipt.threadId,
    cursors,
  });

  expect(messages.streams).toEqual({ kind: "deltas", deltas });
  expect(deltas.length).toBeGreaterThan(0);

  const next = await alice.query(api.agents.messages, {
    ...args,
    paginationOpts: { cursor: wrapped.continueCursor, numItems: 1 },
  });

  expect(next.page.map((m) => m.text)).toEqual(["hello native"]);
});
