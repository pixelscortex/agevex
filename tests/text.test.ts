// @vitest-environment edge-runtime
/** Background title/summary contracts through real native Agent and Workflow. */
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import native from "@convex-dev/agent/test";
import agevex from "../src/test.js";
import { components } from "./fixture/api.js";
import schema from "./fixture/schema.js";
import { requireReceipt } from "./receipt.js";
import { state, reset, exports, api, titleModel, summaryModel, registration } from "./text.host.js";
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
  const args = { threadId: receipt.threadId, text: "User title" };

  expect(await owner(t).mutation(api.agents.rename, args)).toMatchObject({ replayed: false });
  expect(await owner(t).mutation(api.agents.rename, args)).toMatchObject({ replayed: true });
  held.release();
  await drain(t);

  expect(await title(t, receipt.threadId)).toEqual({ text: "User title" });

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
  expect(await title(t, receipt.threadId)).toEqual({ text: null });
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
    }),
  ).rejects.toThrow("FORBIDDEN");

  await expect(
    foreign.mutation(api.agents.summarize, { threadId: receipt.threadId, requestKey: "foreign" }),
  ).rejects.toThrow("FORBIDDEN");
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

it("a configured title or summary output cap reaches the model call", async () => {
  state.title = { model: titleModel, maxOutputTokens: 40 };
  state.summary = { model: summaryModel, maxOutputTokens: 300 };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  await owner(t).mutation(api.agents.summarize, { threadId: receipt.threadId, requestKey: "cap" });
  await drain(t);
  expect(state.titleCalls.map((call) => call.maxOutputTokens)).toEqual([40]);
  expect(state.summaryCalls.map((call) => call.maxOutputTokens)).toEqual([300]);
});

it("without a configured cap the title keeps 128 output tokens and the summary 2048", async () => {
  state.summary = { model: summaryModel };
  const t = setup();
  const receipt = await open(t);

  await drain(t);

  await owner(t).mutation(api.agents.summarize, {
    threadId: receipt.threadId,
    requestKey: "default",
  });

  await drain(t);
  expect(state.titleCalls.map((call) => call.maxOutputTokens)).toEqual([128]);
  expect(state.summaryCalls.map((call) => call.maxOutputTokens)).toEqual([2048]);
});

it("an out-of-range output cap is refused at registration", () => {
  for (const maxOutputTokens of [0, -1, 1.5, 4097, Number.NaN]) {
    state.title = { model: titleModel, maxOutputTokens };
    expect(() => registration()).toThrow("INVALID_TEXT_OPTIONS");
    reset();
    state.summary = { model: summaryModel, maxOutputTokens };
    expect(() => registration()).toThrow("INVALID_TEXT_OPTIONS");
    reset();
  }
});

it("summary hard-maximum windows bound full native reads", async () => {
  state.title = false;
  state.summary = { model: summaryModel };
  // Twelve native assistant docs at 210 KiB each exceed the native query
  // byte budget. The bounded query stops at its first crossing document. Provider metadata is not model input.
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

it("summary input obeys its byte ceiling independently of full native document sizes", async () => {
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

const requestSummary = (t: Test, threadId: string, requestKey: string) =>
  owner(t).mutation(api.agents.summarize, { threadId, requestKey });

it("summary content lives only in the native Agent thread and reads native app updates", async () => {
  state.summary = { model: summaryModel };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(state.summaryCalls).toHaveLength(0);
  await requestSummary(t, receipt.threadId, "native");
  await drain(t);

  expect(
    await t.query(components.agent.threads.getThread, { threadId: receipt.threadId }),
  ).toMatchObject({ summary: state.summaryText });

  await t.mutation(components.agent.threads.updateThread, {
    threadId: receipt.threadId,
    patch: { summary: "App summary" },
  });

  expect(await summary(t, receipt.threadId)).toEqual({ text: "App summary" });
  await requestSummary(t, receipt.threadId, "next");
  await drain(t);
  expect(JSON.stringify(state.summaryCalls[1].prompt)).toContain("App summary");
});

it("unknown summaries preserve native text and repeated keys never repeat paid work", async () => {
  state.summary = { model: summaryModel };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  await requestSummary(t, receipt.threadId, "good");
  await drain(t);
  state.failSummary = true;
  await requestSummary(t, receipt.threadId, "unknown");
  await drain(t);
  expect(await summary(t, receipt.threadId)).toEqual({ text: state.summaryText });
  expect(await requestSummary(t, receipt.threadId, "unknown")).toEqual({ status: "replayed" });
  await send(t, receipt.threadId, "no automatic retry");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  state.failSummary = false;
  await requestSummary(t, receipt.threadId, "fresh");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(3);
});

it("summary cancellation fences late publication while retaining incurred usage", async () => {
  state.title = false;
  state.summary = { model: summaryModel };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const held = gate();

  state.summaryGate = held.promise;
  await requestSummary(t, receipt.threadId, "cancelled");
  await until(t, () => state.summaryCalls.length === 1);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
  expect(await summary(t, receipt.threadId)).toBeNull();
  expect(state.usage.filter((entry) => entry.facts.purpose === "summary")).toHaveLength(1);
  state.summaryGate = undefined;
  await send(t, receipt.threadId, "new request");
  await drain(t);
  await requestSummary(t, receipt.threadId, "fresh");
  await drain(t);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
});

it("known invalid summary output needs a fresh request and never buys a repair", async () => {
  state.summary = { model: summaryModel };
  state.invalidSummary = true;
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  await requestSummary(t, receipt.threadId, "invalid");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  expect(await summary(t, receipt.threadId)).toBeNull();
  state.invalidSummary = false;
  expect(await requestSummary(t, receipt.threadId, "invalid")).toEqual({ status: "replayed" });
  await requestSummary(t, receipt.threadId, "fresh");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
});

it("background usage failure marks evidence partial without retrying text generation", async () => {
  state.usageFails = true;
  state.summary = { model: summaryModel };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  await requestSummary(t, receipt.threadId, "meter failure");
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

it("background string models use the host default provider and preserve purpose attribution", async () => {
  const resolved: string[] = [];

  vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", {
    specificationVersion: "v4",
    languageModel: (id: string) => {
      resolved.push(id);

      return id === "host/title" ? titleModel : summaryModel;
    },
  });

  state.title = { model: "host/title" };
  state.summary = { model: "host/summary" };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  await requestSummary(t, receipt.threadId, "provider");
  await drain(t);
  expect(resolved).toEqual(expect.arrayContaining(["host/title", "host/summary"]));

  expect(state.usage.map((entry) => entry.facts.purpose)).toEqual(
    expect.arrayContaining(["title", "summary"]),
  );

  expect(state.usage.find((entry) => entry.facts.purpose === "summary")).toMatchObject({
    facts: { rootThreadId: receipt.threadId, runId: (await activity(t, receipt.threadId)).runId },
    requestId: "request-summary",
  });
});

it("one summary per thread bounds admission while identical keys replay", async () => {
  state.title = false;
  state.summary = { model: summaryModel };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const held = gate();

  state.summaryGate = held.promise;
  await requestSummary(t, receipt.threadId, "first");
  await until(t, () => state.summaryCalls.length === 1);
  expect(await requestSummary(t, receipt.threadId, "first")).toEqual({ status: "replayed" });
  await expect(requestSummary(t, receipt.threadId, "second")).rejects.toThrow("SUMMARY_BUSY");
  held.release();
  await drain(t);
  state.summaryGate = undefined;
  await requestSummary(t, receipt.threadId, "second");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
});

it("summary timeout releases bounded admission without retrying an unknown paid request", async () => {
  state.title = false;
  state.summary = { model: summaryModel };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const held = gate();

  state.summaryGate = held.promise;
  await requestSummary(t, receipt.threadId, "first");
  await until(t, () => state.summaryCalls.length === 1);

  await t.action(async () => {
    await vi.advanceTimersByTimeAsync(35_001);
  });

  await t.finishInProgressScheduledFunctions();
  state.summaryGate = undefined;
  expect(await requestSummary(t, receipt.threadId, "first")).toEqual({ status: "replayed" });
  await requestSummary(t, receipt.threadId, "second");
  await drain(t);
  held.release();
  await drain(t);
  expect(state.summaryCalls).toHaveLength(2);
  expect(await summary(t, receipt.threadId)).not.toBeNull();
});

it("escaped summary output obeys encoded byte bounds without changing native metadata", async () => {
  state.title = false;
  state.summary = { model: summaryModel };
  state.summaryText = "\u0000".repeat(2000);
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  await requestSummary(t, receipt.threadId, "escaped");
  await drain(t);
  expect(state.summaryCalls).toHaveLength(1);
  expect(await summary(t, receipt.threadId)).toBeNull();
});
