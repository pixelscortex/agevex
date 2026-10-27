// @vitest-environment edge-runtime
/** Background title contracts through real native Agent and Workflow. */
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import native from "@convex-dev/agent/test";
import agevex from "../src/testing/test.js";
import { components } from "./fixture/api.js";
import schema from "./fixture/schema.js";
import { requireReceipt } from "./receipt.js";
import { state, reset, exports, api, titleModel, registration } from "./text.host.js";
import { LIMITS } from "../src/component/limits.js";
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

  // The rejected answer was paid for; its request id lets the host reconcile it.
  expect(state.usageAttempts.find((event) => event.purpose === "title")).toMatchObject({
    status: "failed",
    requestId: "request-title",
  });

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
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

it("foreign subjects cannot read or rename a title", async () => {
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const foreign = t.withIdentity({ subject: "bob" });

  await expect(foreign.query(api.agents.title, { threadId: receipt.threadId })).rejects.toThrow(
    "FORBIDDEN",
  );

  await expect(
    foreign.mutation(api.agents.rename, { threadId: receipt.threadId, text: "foreign" }),
  ).rejects.toThrow("FORBIDDEN");
});

it.each([undefined, 40])("title output cap reaches the provider (%s)", async (maxOutputTokens) => {
  state.title = { model: titleModel, maxOutputTokens };
  const t = setup();

  await open(t);
  await drain(t);
  expect(state.titleCalls.map((call) => call.maxOutputTokens)).toEqual([maxOutputTokens ?? 128]);
});

it("title output caps are validated before acceptance", () => {
  for (const maxOutputTokens of [0, -1, 1.5, 4097, Number.NaN]) {
    state.title = { model: titleModel, maxOutputTokens };
    expect(() => registration()).toThrow("INVALID_TEXT_OPTIONS");
  }
});

it.each(["throw", "stall"])(
  "title hooks that always %s exhaust bounded attempts before partial without repeating paid work",
  async (failure) => {
    state.titleUsageFailures = LIMITS.usageRecordAttempts;
    state.titleUsageStalls = failure === "stall";
    const t = setup();
    const receipt = await open(t);

    await drain(t);
    expect((await title(t, receipt.threadId)).text).toBe("Generated title");
    expect(state.titleCalls).toHaveLength(1);
    const attempts = state.usageAttempts.filter((event) => event.purpose === "title");

    expect(attempts).toHaveLength(LIMITS.usageRecordAttempts);
    expect(new Set(attempts.map((event) => event.key)).size).toBe(1);
    expect(new Set(attempts.map((event) => event.occurredAt)).size).toBe(1);
    expect(state.usage.filter((event) => event.facts.purpose === "title")).toHaveLength(0);
    const runId = (await activity(t, receipt.threadId)).runId!;

    expect(await t.query(components.agevex.turns.slices.usageReporting, { runId })).toBe(true);

    expect(await activity(t, receipt.threadId)).toMatchObject({
      turnStatus: "idle",
      errorCode: null,
    });
  },
);

it("a title hook that throws once retries the same event, records once and keeps reporting complete", async () => {
  state.titleUsageFailures = 1;
  const t = setup();
  const receipt = await open(t);
  const before = Date.now();

  await drain(t);
  const attempts = state.usageAttempts.filter((event) => event.purpose === "title");

  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
  expect(attempts[0].status).toBe("success");
  expect(attempts[0].occurredAt).toBeGreaterThanOrEqual(before);
  expect(state.usage.filter((event) => event.facts.purpose === "title")).toHaveLength(1);
  expect(state.titleCalls).toHaveLength(1);
  expect((await title(t, receipt.threadId)).text).toBe("Generated title");
  const runId = (await activity(t, receipt.threadId)).runId!;

  expect(await t.query(components.agevex.turns.slices.usageReporting, { runId })).toBe(false);
});

it("title string models preserve provider response identity and attribution", async () => {
  vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", {
    specificationVersion: "v4",
    languageModel: () => titleModel,
  });

  state.title = { model: "host/title" };
  const t = setup();
  const receipt = await open(t);

  await drain(t);

  expect(state.usage.find((entry) => entry.facts.purpose === "title")).toMatchObject({
    facts: {
      subject: "alice",
      threadId: receipt.threadId,
      rootThreadId: receipt.threadId,
      runId: (await activity(t, receipt.threadId)).runId,
    },
    requestId: "request-title",
  });
});
