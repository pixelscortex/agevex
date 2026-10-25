import { requireReceipt } from "./receipt.js";
// One native transcript reader for every owned managed conversation.
// These tests use the registered host endpoints and deterministic mock models;
// no provider, key or network is involved.
import { it, expect, vi, afterEach, beforeEach } from "vite-plus/test";
import type { Infer } from "convex/values";
import type { subagentRun } from "../src/component/schema.js";
import { setup, api, state } from "./setup.js";
import { delegationsQuery } from "./host.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Convex = ReturnType<typeof setup>;
const drain = (t: Convex) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
const paginationOpts = { cursor: null, numItems: 20 };

const runs = async (t: Convex, threadId: string) => {
  const result = await t
    .withIdentity({ subject: "alice" })
    .query(delegationsQuery, { threadId, paginationOpts });

  return result.page as Infer<typeof subagentRun>[];
};

const read = (t: Convex, threadId: string, subject = "alice") =>
  t.withIdentity({ subject }).query(api.agents.messages, { threadId, paginationOpts });

/** Complete one real managed delegation, then discover its child via the public query. */
async function delegated(t: Convex) {
  state.delegate = true;

  const { threadId } = await t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "research this",
      requestKey: "r1",
    })
    .then(requireReceipt);

  await drain(t);
  await drain(t);
  const children = await runs(t, threadId);

  expect(children).toHaveLength(1);
  const childThreadId = children[0].childThreadId;

  if (!childThreadId) throw new Error("CHILD_THREAD_MISSING");

  return { threadId, childThreadId, run: children[0] };
}

it("the owner reads a child's task prompt and reply through messages", async () => {
  const t = setup();
  const { threadId, childThreadId } = await delegated(t);
  const child = await read(t, childThreadId);
  const texts = child.page.map((message: { text: string }) => message.text);

  expect(texts).toContain("research the bounded question");
  expect(texts).toContain("RESEARCHER deterministic native result");

  expect(
    child.page.some((message: { agentName?: string }) => message.agentName === "Researcher"),
  ).toBe(true);

  // The reader must return the child's actual conversation, not the parent's
  // delivered-result notification. Native message ids distinguish the threads.
  const root = await read(t, threadId);
  const rootIds = new Set(root.page.map((message: { id: string }) => message.id));

  expect(child.page.every((message: { id: string }) => !rootIds.has(message.id))).toBe(true);
});

it("another user gets FORBIDDEN when reading a child thread", async () => {
  const t = setup();
  const { childThreadId } = await delegated(t);

  await expect(read(t, childThreadId, "mallory")).rejects.toThrow(/FORBIDDEN/);
});

it("send into a child thread is FORBIDDEN", async () => {
  const t = setup();
  const { childThreadId } = await delegated(t);
  const before = await read(t, childThreadId);

  await expect(
    t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
      threadId: childThreadId,
      text: "start another child turn",
      requestKey: "child-send",
    }),
  ).rejects.toThrow(/FORBIDDEN/);

  // A refused send cannot append a native prompt or schedule another generation.
  await drain(t);
  expect(await read(t, childThreadId)).toEqual(before);
  expect(state.offers.filter((offer) => offer.agent === "Researcher")).toHaveLength(1);
});

it("activity on a child thread is FORBIDDEN", async () => {
  const t = setup();
  const { childThreadId } = await delegated(t);

  await expect(
    t.withIdentity({ subject: "alice" }).query(api.agents.activity, { threadId: childThreadId }),
  ).rejects.toThrow(/FORBIDDEN/);
});

it("open rejects an agent registered only as a child", async () => {
  const t = setup();

  await expect(
    t
      .withIdentity({ subject: "alice" })
      .mutation(api.agents.open, {
        agent: "Researcher",
        prompt: "bypass delegation",
        requestKey: "child-open",
      })
      .then(requireReceipt),
  ).rejects.toThrow("UNKNOWN_AGENT");
});

it("send stays FORBIDDEN for an old child thread after its agent is registered as a root", async () => {
  const t = setup();
  const { childThreadId } = await delegated(t);

  await expect(
    t.withIdentity({ subject: "alice" }).mutation(api.promoted.send, {
      threadId: childThreadId,
      text: "start another child turn",
      requestKey: "promoted-child-send",
    }),
  ).rejects.toThrow("FORBIDDEN");
});

it("activity stays FORBIDDEN for an old child thread after its agent is registered as a root", async () => {
  const t = setup();
  const { childThreadId } = await delegated(t);

  await expect(
    t.withIdentity({ subject: "alice" }).query(api.promoted.activity, { threadId: childThreadId }),
  ).rejects.toThrow("FORBIDDEN");
});

it("delegations returns the run's childThreadId for reading its transcript through messages", async () => {
  const t = setup();
  const { threadId, childThreadId, run } = await delegated(t);
  const listed = await runs(t, threadId);

  expect(listed[0]).toMatchObject({ runId: run.runId, childThreadId });
  expect(childThreadId).not.toBe(threadId);
  const child = await read(t, childThreadId);

  expect(child.page.map((message: { text: string }) => message.text)).toEqual(
    expect.arrayContaining([
      "research the bounded question",
      "RESEARCHER deterministic native result",
    ]),
  );
});
