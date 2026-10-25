// @vitest-environment edge-runtime
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { listMessages } from "@convex-dev/agent";
import { workflowCall } from "../src/testing/expect-journal.js";
import { setup, api, components, state } from "./setup.js";
import { expectJournalUnchanged } from "../src/test.js";
import journals from "./fixtures/workflow-journals.json";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 2000);
// Abort listeners now close recorded placeholders, so fake-time callbacks need syscall scope.
const tick = (t: ReturnType<typeof setup>, ms: number) =>
  t.action(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const open = (t: ReturnType<typeof setup>, requestKey = "durable") =>
  t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.open, { agent: "Main", prompt: "durable prompt", requestKey });
const admission = {
  scope: "external:test",
  key: "stable-key",
  fingerprint: "same-input",
  leaseMs: 10,
};

it("expired lease becomes unknown and a late completion cannot change it", async () => {
  const t = setup();
  const first = await t.mutation(components.agevex.ledger.begin, admission);
  expect(first.status).toBe("claimed");
  vi.advanceTimersByTime(11);
  expect(await t.mutation(components.agevex.ledger.begin, admission)).toEqual({
    status: "unknown",
  });
  if (first.status !== "claimed") throw new Error("not claimed");
  await t.mutation(components.agevex.ledger.complete, {
    scope: admission.scope,
    key: admission.key,
    claim: first.claim,
    result: "late",
  });
  expect(await t.mutation(components.agevex.ledger.begin, admission)).toEqual({
    status: "unknown",
  });
});

it("KEY_CONFLICT on reused key with new input", async () => {
  const t = setup();
  await t.mutation(components.agevex.ledger.begin, admission);
  expect(
    await t.mutation(components.agevex.ledger.begin, { ...admission, fingerprint: "different" }),
  ).toEqual({ status: "conflict", code: "KEY_CONFLICT" });
});

it("repeatSafe re-claims an expired lease and fences the previous claim", async () => {
  const t = setup();
  const first = await t.mutation(components.agevex.ledger.begin, admission);
  vi.advanceTimersByTime(11);
  const next = await t.mutation(components.agevex.ledger.begin, { ...admission, repeatSafe: true });
  if (first.status !== "claimed" || next.status !== "claimed") throw new Error("not claimed");
  expect(first.claim).not.toBe(next.claim);
  await t.mutation(components.agevex.ledger.complete, {
    scope: admission.scope,
    key: admission.key,
    claim: first.claim,
    result: "stale",
  });
  expect(await t.mutation(components.agevex.ledger.begin, admission)).toEqual({
    status: "running",
  });
  await t.mutation(components.agevex.ledger.complete, {
    scope: admission.scope,
    key: admission.key,
    claim: next.claim,
    result: "current",
  });
  expect(await t.mutation(components.agevex.ledger.begin, admission)).toEqual({
    status: "done",
    result: "current",
  });
});

it("cancel stops a running turn and drops its late writes", async () => {
  const t = setup();
  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });
  const receipt = await open(t);
  await expect
    .poll(async () => {
      await tick(t, 100);
      return state.calls.length;
    })
    .toBe(1);
  const alice = t.withIdentity({ subject: "alice" });
  await expect(
    t
      .withIdentity({ subject: "mallory" })
      .mutation(api.agents.cancel, { threadId: receipt.threadId }),
  ).rejects.toThrow("FORBIDDEN");
  await alice.mutation(api.agents.cancel, { threadId: receipt.threadId });
  await tick(t, 1_100);
  expect(state.calls[0].abortSignal?.aborted).toBe(true);
  state.release!();
  state.gate = undefined;
  await drain(t);
  const messages = await alice.query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(messages.page.some((message) => message.text.includes("DEMO deterministic"))).toBe(false);
  const native = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    }),
  );
  expect(native.page.some((message) => message.status === "pending")).toBe(false);
  expect(
    await t.query(components.agent.streams.list, {
      threadId: receipt.threadId,
      statuses: ["streaming"],
    }),
  ).toEqual([]);
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
  });
  // A fresh send gets a new execution id and epoch; cancellation is recoverable.
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "after cancel",
    requestKey: "after",
  });
  await drain(t);
  expect(state.calls).toHaveLength(2);
});

it("root cancellation blocks a running child's late result after a fresh send", async () => {
  const t = setup();
  state.delegate = true;
  state.childGate = new Promise((resolve) => {
    state.childRelease = resolve;
  });
  const receipt = await open(t);
  await expect
    .poll(async () => {
      await tick(t, 100);
      return state.offers.filter((offer) => offer.agent === "Researcher").length;
    })
    .toBe(1);
  const alice = t.withIdentity({ subject: "alice" });
  const before = await alice.query(api.agents.delegations, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  const childThreadId = before.page[0].childThreadId!;
  await expect(alice.mutation(api.agents.cancel, { threadId: childThreadId })).rejects.toThrow(
    "FORBIDDEN",
  );
  await alice.mutation(api.agents.cancel, { threadId: receipt.threadId });
  state.delegate = false;
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "fresh work",
    requestKey: "fresh-work",
  });
  await tick(t, 1_100);
  state.childRelease!();
  state.childGate = undefined;
  await drain(t);
  const history = await alice.query(api.agents.delegations, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(history.page).toHaveLength(1);
  expect(history.page[0]).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
  expect(state.calls).toHaveLength(2);
  const rootMessages = await alice.query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(JSON.stringify(rootMessages)).not.toContain("RESEARCHER deterministic");
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    subagents: { active: 0 },
  });
});

it("no turn starts while an approval is pending and its inbox row waits", async () => {
  const t = setup();
  state.tools = true;
  state.approval = true;
  const receipt = await open(t);
  await drain(t);
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "must wait",
    requestKey: "waiting",
  });
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    queuedMessages: 2,
  });
  const messages = await alice.query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(JSON.stringify(messages)).not.toContain("auto-denied");
});

it("a lost or duplicate ping is harmless because the inbox owns work", async () => {
  const t = setup();
  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });
  const receipt = await open(t);
  await expect
    .poll(async () => {
      await tick(t, 100);
      return state.calls.length;
    })
    .toBe(1);
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "second prompt",
    requestKey: "second",
  });
  const execution = await t.query(components.agevex.queue.execution, {
    assignmentId: receipt.assignmentId,
  });
  // Drop all early doorbells, then send duplicates. Neither operation changes
  // the accepted inbox, which the loop rechecks after finishing the first turn.
  await workflowCall(t, "agevex/rootWorkflow", "mutation", "agevexJournal", "dropPings", {
    workflowId: execution!.workflowId!,
  });
  await workflowCall(t, "agevex/rootWorkflow", "mutation", "event", "send", {
    workflowId: execution!.workflowId!,
    name: "ping",
    result: { kind: "success", returnValue: null },
  });
  await workflowCall(t, "agevex/rootWorkflow", "mutation", "event", "send", {
    workflowId: execution!.workflowId!,
    name: "ping",
    result: { kind: "success", returnValue: null },
  });
  state.release!();
  state.gate = undefined;
  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
  });
});

// Ping coalescing removes idle repetitions from fixtures; version 1 step order stays unchanged.
it("journal replay preserves the committed basic step sequence", async () => {
  const t = setup();
  await open(t);
  await drain(t);
  const before = state.calls.length;
  await expectJournalUnchanged(t, "agevex/rootWorkflow", journals.basic);
  expect(state.calls).toHaveLength(before);
});

it("journal replay preserves the committed delegating step sequence", async () => {
  const t = setup();
  state.delegate = true;
  await open(t);
  await drain(t);
  const before = state.offers.length;
  await expectJournalUnchanged(t, "agevex/rootWorkflow", journals.delegatingRoot);
  await expectJournalUnchanged(t, "agevex/childWorkflow", journals.delegatingChild);
  expect(state.offers).toHaveLength(before);
});

it("defineOnceTool reuses its result and injects trusted facts without repeating the effect", async () => {
  const t = setup();
  state.once = true;
  const receipt = await open(t);
  await drain(t);
  expect(state.calls).toHaveLength(3);
  expect(state.onceCalls).toBe(1);
  expect(state.onceContext).toMatchObject({
    subject: "alice",
    threadId: receipt.threadId,
    toolCallId: "effect-1",
  });
  expect(state.onceContext?.runId).toBeTruthy();
  expect(state.onceContext?.signal).toBeInstanceOf(AbortSignal);
  const messages = await t.withIdentity({ subject: "alice" }).query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(JSON.stringify(messages)).toContain("one effect");
});
