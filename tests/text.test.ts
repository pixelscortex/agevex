// @vitest-environment edge-runtime
/** Background title/summary contracts through real native Agent and Workflow. */
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import native from "@convex-dev/agent/test";
import agevex from "../src/test.js";
import { getConvexSize } from "convex/values";
import { components, rawAssignment } from "./fixture/api.js";
import schema from "./fixture/schema.js";
import { requireReceipt } from "./receipt.js";
import { state, reset, exports, api, titleModel, summaryModel } from "./text.host.js";
const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

function setup() {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: { ...modules, "./fixture/agents.ts": async () => exports() },
  });

  native.register(t);
  agevex.register(t);

  return t;
}
type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });

const open = async (t: Test) =>
  requireReceipt(
    await owner(t).mutation(api.agents.open, {
      agent: "Main",
      prompt: "first user message",
      requestKey: "first",
    }),
  );

const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);

const send = (t: Test, threadId: string, key: string) =>
  owner(t).mutation(api.agents.send, { threadId, text: key, requestKey: key });

const summary = (t: Test, threadId: string) => owner(t).query(api.agents.summary, { threadId });
const title = (t: Test, threadId: string) => owner(t).query(api.agents.title, { threadId });
const activity = (t: Test, threadId: string) => owner(t).query(api.agents.activity, { threadId });

/** Drive only short scheduler intervals while another model is deliberately held. */
async function until(t: Test, predicate: () => boolean | Promise<boolean>) {
  await expect
    .poll(async () => {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      return predicate();
    })
    .toBe(true);
}
function gate() {
  let release!: () => void;

  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("first message schedules one title before the assistant answers", async () => {
  const held = gate();

  state.mainGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  await until(t, () => state.titleCalls.length === 1);
  await until(t, async () => (await title(t, receipt.threadId)).text === "Generated title");
  await until(t, () => state.mainCalls.length === 1);
  expect(await activity(t, receipt.threadId)).toMatchObject({ turnStatus: "running" });
  held.release();
  await drain(t);
  await send(t, receipt.threadId, "next");
  await drain(t);
  expect(state.titleCalls).toHaveLength(1);
  expect(JSON.stringify(state.titleCalls[0].prompt)).toContain("first user message");
});

it("a slow title never holds the foreground root lane", async () => {
  state.title = { model: titleModel };
  const held = gate();

  state.titleGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  await until(
    t,
    async () =>
      state.titleCalls.length === 1 && (await activity(t, receipt.threadId)).turnStatus === "idle",
  );

  expect((await activity(t, receipt.threadId)).errorCode).toBeNull();
  held.release();
  await drain(t);
});

it("user rename wins over a late generated title and identical rename replays", async () => {
  const held = gate();

  state.titleGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  await until(t, () => state.titleCalls.length === 1);
  const args = { threadId: receipt.threadId, text: "User title", expectedVersion: 0 };

  expect(await owner(t).mutation(api.agents.rename, args)).toMatchObject({ replayed: false });
  expect(await owner(t).mutation(api.agents.rename, args)).toMatchObject({ replayed: true });
  held.release();
  await drain(t);

  expect(await title(t, receipt.threadId)).toEqual({
    text: "User title",
    source: "user",
    version: 1,
  });

  await expect(
    owner(t).mutation(api.agents.rename, { ...args, text: "Conflicting title" }),
  ).rejects.toThrow("VERSION_CONFLICT");

  await send(t, receipt.threadId, "later");
  await drain(t);
  expect((await title(t, receipt.threadId)).text).toBe("User title");
});

it("title disabled makes no metadata model call", async () => {
  state.title = false;
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(state.titleCalls).toHaveLength(0);
  expect(state.mainCalls).toHaveLength(1);
  expect(await title(t, receipt.threadId)).toEqual({ text: null, source: null, version: 0 });
});

it("summary runs only when opted in and request keys replay scheduling", async () => {
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(state.summaryCalls).toHaveLength(0);

  await expect(
    owner(t).mutation(api.agents.summarize, { threadId: receipt.threadId, requestKey: "disabled" }),
  ).rejects.toThrow("SUMMARY_DISABLED");

  state.summary = { model: summaryModel };
  await send(t, receipt.threadId, "enabled");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(0);
  const args = { threadId: receipt.threadId, requestKey: "requested" };

  expect(await owner(t).mutation(api.agents.summarize, args)).toEqual({ status: "queued" });
  expect(await owner(t).mutation(api.agents.summarize, args)).toEqual({ status: "replayed" });
  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  expect(await summary(t, receipt.threadId)).toMatchObject({ text: "Summary of earlier turns" });
});

it("every-N cadence counts completed root turns", async () => {
  state.summary = { model: summaryModel, everyTurns: 2 };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(state.summaryCalls).toHaveLength(0);
  await send(t, receipt.threadId, "two");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  const first = await summary(t, receipt.threadId);

  await send(t, receipt.threadId, "three");
  await drain(t);
  expect(await summary(t, receipt.threadId)).toEqual(first);
  await send(t, receipt.threadId, "four");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect((await summary(t, receipt.threadId))?.throughMessageId).not.toBe(first?.throughMessageId);
  expect(JSON.stringify(state.summaryCalls[1].prompt)).toContain("Summary of earlier turns");
});

it("summary failure leaves the conversation and prior summary unaffected without paid retries", async () => {
  state.summary = { model: summaryModel, everyTurns: 1 };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const before = await summary(t, receipt.threadId);

  state.failSummary = true;
  await send(t, receipt.threadId, "two");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect(await summary(t, receipt.threadId)).toEqual(before);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });

  await send(t, receipt.threadId, "three");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect(state.mainCalls).toHaveLength(3);
});

it("background usage records title and summary purpose with the triggering root run", async () => {
  state.summary = { model: summaryModel, everyTurns: 1 };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const runId = (await activity(t, receipt.threadId)).runId;

  expect(state.usage.filter((entry) => entry.facts.purpose === "title")).toEqual([
    {
      facts: expect.objectContaining({ purpose: "title", runId, rootThreadId: receipt.threadId }),
      requestId: "request-title",
    },
  ]);

  expect(state.usage.filter((entry) => entry.facts.purpose === "summary")).toEqual([
    { facts: expect.objectContaining({ purpose: "summary", runId }), requestId: "request-summary" },
  ]);

  expect(state.titleCalls[0].maxOutputTokens).toBe(128);
  expect(state.summaryCalls[0].maxOutputTokens).toBe(2048);
});

it("display summaries always leave native context unchanged", async () => {
  state.summary = { model: summaryModel, everyTurns: 1 };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  await send(t, receipt.threadId, "second task");
  await drain(t);
  expect(JSON.stringify(state.mainCalls[1].prompt)).toContain("first user message");
  expect(JSON.stringify(state.mainCalls[1].prompt)).not.toContain("Conversation summary:");
});

it("title generation survives cancellation while retaining incurred usage", async () => {
  const held = gate();

  state.titleGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  await until(t, () => state.titleCalls.length === 1);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
  expect((await title(t, receipt.threadId)).text).toBe("Generated title");
  expect(state.usage.some((entry) => entry.facts.purpose === "title")).toBe(true);
});

it("foreign subjects cannot read or change thread metadata", async () => {
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const foreign = t.withIdentity({ subject: "bob" });

  await expect(foreign.query(api.agents.title, { threadId: receipt.threadId })).rejects.toThrow(
    "FORBIDDEN",
  );

  await expect(foreign.query(api.agents.summary, { threadId: receipt.threadId })).rejects.toThrow(
    "FORBIDDEN",
  );

  await expect(
    foreign.mutation(api.agents.rename, {
      threadId: receipt.threadId,
      text: "foreign",
      expectedVersion: 0,
    }),
  ).rejects.toThrow("FORBIDDEN");

  await expect(
    foreign.mutation(api.agents.summarize, { threadId: receipt.threadId, requestKey: "foreign" }),
  ).rejects.toThrow("FORBIDDEN");
});

it("concurrent summary requests serialize and coalesce newer boundaries", async () => {
  state.title = false;
  state.summary = { model: summaryModel, everyTurns: 1 };
  const held = gate();

  state.summaryGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  await until(t, () => state.summaryCalls.length === 1);
  await send(t, receipt.threadId, "second");

  await until(
    t,
    async () =>
      state.mainCalls.length === 2 && (await activity(t, receipt.threadId)).turnStatus === "idle",
  );

  expect(state.summaryCalls).toHaveLength(1);
  held.release();
  state.summaryGate = undefined;
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect(JSON.stringify(state.summaryCalls[1].prompt)).toContain("second");
});

it("a known-invalid summary can be explicitly requested again without retrying its receipt", async () => {
  state.title = false;
  state.summary = { model: summaryModel, everyTurns: 1 };
  state.invalidSummary = true;
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  expect(await summary(t, receipt.threadId)).toBeNull();
  state.invalidSummary = false;

  await owner(t).mutation(api.agents.summarize, {
    threadId: receipt.threadId,
    requestKey: "fresh",
  });

  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
});

it("metadata timeout stops waiting for an uncooperative model and never retries a late answer", async () => {
  const held = gate();

  state.titleGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  await until(t, () => state.titleCalls.length === 1);

  await t.action(async () => {
    await vi.advanceTimersByTimeAsync(30_001);
  });

  await t.finishInProgressScheduledFunctions();
  expect((await title(t, receipt.threadId)).text).toBeNull();

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });

  held.release();
  await drain(t);
  await send(t, receipt.threadId, "after timeout");
  await drain(t);
  expect(state.titleCalls).toHaveLength(1);
  expect((await title(t, receipt.threadId)).text).toBeNull();
  expect(state.usage.filter((entry) => entry.facts.purpose === "title")).toHaveLength(1);
});

it("a cancelled first turn still gets a title from its accepted message", async () => {
  const t = setup();
  const receipt = await open(t);

  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  await drain(t);
  expect(state.titleCalls).toHaveLength(1);
  expect((await title(t, receipt.threadId)).text).toBe("Generated title");
  expect(JSON.stringify(state.titleCalls[0].prompt)).toContain("first user message");
});

it("background authorization is rechecked before metadata spend", async () => {
  const t = setup();
  const receipt = await open(t);

  state.revoke = true;
  await drain(t);
  expect(state.titleCalls).toHaveLength(0);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it("usage recording failure never prevents metadata or retries generation", async () => {
  state.usageFails = true;
  state.summary = { model: summaryModel, everyTurns: 1 };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect((await title(t, receipt.threadId)).text).toBe("Generated title");
  expect(await summary(t, receipt.threadId)).not.toBeNull();
  expect(state.titleCalls).toHaveLength(1);
  expect(state.summaryCalls).toHaveLength(1);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it("title uses the configured prompt and rejects oversized output without a repair call", async () => {
  state.title = { model: titleModel, prompt: "Describe this in three words." };
  state.titleText = "x".repeat(121);
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(state.titleCalls).toHaveLength(1);
  expect(JSON.stringify(state.titleCalls[0].prompt)).toContain("Describe this in three words.");
  expect((await title(t, receipt.threadId)).text).toBeNull();

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it("summary hard-maximum windows bound full native reads", async () => {
  state.title = false;
  state.summary = { model: summaryModel };
  // Twelve native assistant docs at 210 KiB each overflow the 2 MiB exact-read
  // budget while the 24-ref ring is full. Provider metadata is not model input.
  state.padding = "x".repeat(210 << 10);
  const t = setup();
  const receipt = await open(t);

  await drain(t);

  for (let n = 2; n <= 12; n++) {
    await send(t, receipt.threadId, `turn ${n}`);
    await drain(t);
  }

  await owner(t).mutation(api.agents.summarize, {
    threadId: receipt.threadId,
    requestKey: "maximum",
  });

  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
  const serialized = JSON.stringify(state.summaryCalls[0].prompt);

  expect(new TextEncoder().encode(serialized).length).toBeLessThan(48 << 10);
  await send(t, receipt.threadId, "after bounded window");
  await drain(t);
  const context = JSON.stringify(state.mainCalls[state.mainCalls.length - 1].prompt);

  expect(context).toContain("first user message");
  expect(context).not.toContain("Conversation summary:");
});

it("summary input obeys its byte ceiling even when the full ring fits the read budget", async () => {
  state.title = false;
  state.summary = { model: summaryModel };
  state.answer = "x".repeat(20 << 10);
  const t = setup();
  const receipt = await open(t);

  await drain(t);

  for (let n = 2; n <= 12; n++) {
    await send(t, receipt.threadId, `turn ${n}`);
    await drain(t);
  }

  await owner(t).mutation(api.agents.summarize, {
    threadId: receipt.threadId,
    requestKey: "bytes",
  });

  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  expect(JSON.stringify(state.summaryCalls[0].prompt).length).toBeLessThan(49 << 10);
  await send(t, receipt.threadId, "preserve unsummarized prefix");
  await drain(t);

  expect(JSON.stringify(state.mainCalls[state.mainCalls.length - 1].prompt)).toContain(
    "first user message",
  );
});

it("a maximum encoded summary and full reference ring stay within the assignment envelope", async () => {
  state.title = false;
  state.summary = { model: summaryModel, everyTurns: 1 };
  state.summaryText = "x".repeat((8 << 10) - 16);
  const t = setup();
  const receipt = await open(t);

  await drain(t);

  for (let n = 2; n <= 12; n++) {
    await send(t, receipt.threadId, `turn ${n}`);
    await drain(t);
  }

  expect((await summary(t, receipt.threadId))?.text).toBe(state.summaryText);

  const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

  expect(row?.contextMessages).toHaveLength(24);

  expect(getConvexSize(row)).toBeLessThanOrEqual(32 << 10);
});

it("escaped summary output is bounded by encoded bytes and cannot inflate the metadata row", async () => {
  state.title = false;
  state.summary = { model: summaryModel, everyTurns: 1 };
  state.summaryText = "\u0000".repeat(2000);
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(await summary(t, receipt.threadId)).toBeNull();
  expect(state.summaryCalls).toHaveLength(1);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it("an early on-demand summary waits for a completed boundary without occupying a worker", async () => {
  state.title = false;
  state.summary = { model: summaryModel };
  const held = gate();

  state.mainGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  expect(
    await owner(t).mutation(api.agents.summarize, {
      threadId: receipt.threadId,
      requestKey: "early",
    }),
  ).toEqual({ status: "queued" });

  await until(t, () => state.mainCalls.length === 1);
  expect(state.summaryCalls).toHaveLength(0);
  held.release();
  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
});

it("slow authorization does not consume the model dispatch lease", async () => {
  state.title = false;
  state.summary = { model: summaryModel, everyTurns: 1 };
  const held = gate();

  state.authorizeGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  await until(t, () => state.authorizing === 1);

  await t.action(async () => {
    await vi.advanceTimersByTimeAsync(40_000);
  });

  held.release();
  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
});

it("cancellation during pre-dispatch authorization leaves summaries retryable", async () => {
  state.title = false;
  state.summary = { model: summaryModel };
  const held = gate();

  state.authorizeGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  await drain(t);

  await owner(t).mutation(api.agents.summarize, {
    threadId: receipt.threadId,
    requestKey: "first-summary",
  });

  await until(t, () => state.authorizing === 1);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
  expect(state.summaryCalls).toHaveLength(0);
  state.authorizeGate = undefined;
  await send(t, receipt.threadId, "new run");
  await drain(t);

  await owner(t).mutation(api.agents.summarize, {
    threadId: receipt.threadId,
    requestKey: "fresh",
  });

  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
});

it("a fresh summary key works after an unknown outcome without replaying paid work", async () => {
  state.title = false;
  state.summary = { model: summaryModel, everyTurns: 1 };
  state.failSummary = true;
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  state.failSummary = false;
  await send(t, receipt.threadId, "next cadence");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  const args = { threadId: receipt.threadId, requestKey: "fresh" };

  expect(await owner(t).mutation(api.agents.summarize, args)).toEqual({ status: "queued" });
  await drain(t);
  expect(await owner(t).mutation(api.agents.summarize, args)).toEqual({ status: "replayed" });
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
});

it("cadence summaries resume at the next cadence point after a known failure", async () => {
  state.title = false;
  state.summary = { model: summaryModel, everyTurns: 1 };
  state.invalidSummary = true;
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(await summary(t, receipt.threadId)).toBeNull();
  state.invalidSummary = false;
  await send(t, receipt.threadId, "next cadence");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
});

it.each(["before dispatch", "during dispatch"])(
  "native app titles survive automatic generation (%s)",
  async (when) => {
    const held = gate();

    state.titleGate = held.promise;
    const t = setup();
    const receipt = await open(t);

    if (when === "during dispatch") await until(t, () => state.titleCalls.length === 1);

    await t.mutation(components.agent.threads.updateThread, {
      threadId: receipt.threadId,
      patch: { title: "App title" },
    });

    held.release();
    await drain(t);
    expect((await title(t, receipt.threadId)).text).toBe("App title");
    expect(state.titleCalls).toHaveLength(when === "before dispatch" ? 0 : 1);
  },
);

it("background string models use the host default provider", async () => {
  const resolved: string[] = [];

  vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", {
    specificationVersion: "v4",
    languageModel: (id: string) => {
      resolved.push(id);

      return id === "host/title" ? titleModel : summaryModel;
    },
  });

  state.title = { model: "host/title" };
  state.summary = { model: "host/summary", everyTurns: 1 };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(resolved).toEqual(expect.arrayContaining(["host/title", "host/summary"]));
  expect((await title(t, receipt.threadId)).text).toBe("Generated title");
  expect(await summary(t, receipt.threadId)).not.toBeNull();
  expect(state.titleCalls).toHaveLength(1);
  expect(state.summaryCalls).toHaveLength(1);
});

it("cadence resumes after cancel during dispatch", async () => {
  state.title = false;
  state.summary = { model: summaryModel, everyTurns: 1 };
  const held = gate();

  state.summaryGate = held.promise;
  const t = setup();
  const receipt = await open(t);

  await until(t, () => state.summaryCalls.length === 1);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
  expect(await summary(t, receipt.threadId)).toBeNull();
  expect(state.usage.filter((entry) => entry.facts.purpose === "summary")).toHaveLength(1);

  // drain includes the expired lease: a known discarded result must stay
  // retryable even after its old expiry runs, without an explicit summary key.
  state.summaryGate = undefined;
  await send(t, receipt.threadId, "next cadence");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
  expect(state.usage.filter((entry) => entry.facts.purpose === "summary")).toHaveLength(2);
});
