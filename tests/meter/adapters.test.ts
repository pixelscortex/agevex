// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import agevex from "../../src/test.js";
import meterComponent from "../../src/meter/test.js";
import { defineMeter, inline, type MeterOptions } from "../../src/meter/index.js";
import { opaqueKey } from "../../src/client/keys.js";
import { scopedMeter } from "../../src/client/slots.js";
import schema from "../fixture/schema.js";
import { components } from "../fixture/api.js";
import { fixture, reset, exports, api, call, text } from "../hooks.host.js";
import { requireReceipt } from "../receipt.js";

const modules = import.meta.glob(["../fixture/**/*.ts", "../fixture/**/*.js"]);

function setup(options: Partial<MeterOptions> = {}, policy?: MeterOptions["budgets"]) {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: { ...modules, "../fixture/agents.ts": async () => exports() },
  });

  agent.register(t);
  agevex.register(t);
  const component = meterComponent.register(t);

  const meter = defineMeter(component, {
    providers: {
      openrouter: inline(),
      fal: { profiles: { image: { unit: "image", usd: 0.25 } } },
      // Agent's real mock stream reports 3 input + 10 output tokens per saved
      // step (agent/src/vercel/client/mockModel.ts:16-28, 177-181). Decode that
      // evidence rather than assigning a charge to calls with missing usage.
      "mock-provider": inline(({ usage }) =>
        (usage as { totalTokens?: number } | undefined)?.totalTokens === 13
          ? { usd: 0.1 }
          : undefined,
      ),
    },
    ...options,
  });

  const usage = meter.usageSlot();
  const scopes = vi.spyOn(usage, "scope");

  fixture.slots = { usage, budget: meter.budgetSlot(policy) };

  return { t, meter, component, scopes };
}
type Test = ReturnType<typeof setup>["t"];
const owner = (t: Test) => t.withIdentity({ subject: "alice" });
const openArgs = { agent: "Main", prompt: "hello", requestKey: "first" };
const open = async (t: Test) => requireReceipt(await owner(t).mutation(api.agents.open, openArgs));
const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
const status = (t: Test, threadId: string) => owner(t).query(api.agents.activity, { threadId });

const facts = () => {
  const tc = fixture.toolContext!;

  return {
    subject: tc.subject,
    rootThreadId: tc.rootThreadId,
    threadId: tc.threadId,
    runId: tc.runId,
    agent: tc.agent,
  };
};

const twoSteps = () => {
  fixture.steps.Main = (n) => (n === 0 ? call("managed", {}) : text("finished"));
};

beforeEach(() => {
  reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("a managed tool records core attribution and the unchanged hashed charge key in meter", async () => {
  twoSteps();
  let key: string | undefined;

  fixture.toolWork = async (tc) => {
    key = (
      await tc.meter.record("openrouter", {
        providerMetadata: { openrouter: { usage: { cost: 0.25 } } },
      })
    ).key;

    return "recorded";
  };

  const { t, component } = setup();
  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
  expect(key).toBe(await opaqueKey("charge", fixture.toolContext!.toolCallId, 0));

  expect(await t.query(component.charges.get, { key: key! })).toMatchObject({
    key,
    attribution: {
      subject: "alice",
      rootThreadId: receipt.threadId,
      threadId: receipt.threadId,
      runId: fixture.toolContext!.runId,
      agent: "Main",
    },
    provider: "openrouter",
    status: "settled",
    source: "inline",
    nanos: 250_000_000,
  });
});

it("each saved model step creates one meter charge and replay adds no charges or cost", async () => {
  twoSteps();
  const { t, meter, component, scopes } = setup();
  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();

  // Inspect a bounded page only to assert the actual saved-step identities.
  // Production attribution and recording use core's exact-id save seam.
  const saved = await t.query(components.agent.messages.listMessagesByThreadId, {
    threadId: receipt.threadId,
    order: "asc",
    paginationOpts: { cursor: null, numItems: 10, maximumBytesRead: 65_536 },
  });

  const steps = saved.page.filter((message) => message.usage && message.status === "success");

  expect(steps).toHaveLength(2);
  const charges = [];

  for (const step of steps) {
    const key = await opaqueKey("model", receipt.threadId, step._id, step.stepOrder);
    const charge = await t.query(component.charges.get, { key });

    expect(charge).toMatchObject({
      key,
      attribution: { ...facts(), model: "mock-model-id" },
      provider: "mock-provider",
      status: "settled",
      nanos: 100_000_000,
    });

    charges.push(charge);
  }

  expect(new Set(charges.map((charge) => charge!._id)).size).toBe(2);
  const before = await t.run((ctx) => meter.threadCost(ctx, { threadId: receipt.threadId }));

  expect(before).toMatchObject({ totalNanos: 200_000_000, unknown: 0 });
  const scopeCount = scopes.mock.calls.length;

  const execution = (await t.query(components.agevex.turns.slices.execution, {
    assignmentId: receipt.assignmentId,
  }))!;

  await t.action(api.agents.runTurn, {
    assignmentId: receipt.assignmentId,
    turnToken: execution.turnToken ?? "stale",
    sliceId: "replay",
  });

  await owner(t).mutation(api.agents.open, openArgs);
  await drain(t);
  expect(fixture.calls).toHaveLength(2);
  expect(scopes).toHaveBeenCalledTimes(scopeCount);

  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: receipt.threadId }))).toEqual(
    before,
  );

  for (const charge of charges)
    expect(await t.query(component.charges.get, { key: charge!.key })).toEqual(charge);
});

it("threadCost and subjectCost include the managed tool and model costs attributed to the run", async () => {
  twoSteps();

  fixture.toolWork = async (tc) => {
    await tc.meter.record("openrouter", {
      providerMetadata: { openrouter: { usage: { cost: 0.25 } } },
    });

    return "recorded";
  };

  const { t, meter } = setup();
  const receipt = await open(t);

  await drain(t);
  const cost = await t.run((ctx) => meter.threadCost(ctx, { threadId: receipt.threadId }));

  expect(cost).toMatchObject({ totalNanos: 450_000_000, settledNanos: 450_000_000, unknown: 0 });
  expect(cost.byAgent.page).toMatchObject([{ key: "Main", totalNanos: 450_000_000 }]);

  expect(
    await t.run((ctx) => meter.subjectCost(ctx, { subject: "alice", runId: facts().runId })),
  ).toMatchObject({ totalNanos: cost.totalNanos, unknown: 0 });

  expect(
    await t.run((ctx) => meter.subjectCost(ctx, { subject: "alice", runId: "another-run" })),
  ).toMatchObject({ totalNanos: 0 });
});

it.each(["configured", "override"])(
  "%s budget below recorded spend ends the next slice with BUDGET_EXCEEDED",
  async (kind) => {
    twoSteps();
    const cap = () => ({ maxUsd: 0.05 });

    const { t, meter } = setup(
      { budgets: kind === "configured" ? cap : () => ({ maxUsd: 5 }) },
      kind === "override" ? cap : undefined,
    );

    const receipt = await open(t);

    await drain(t);

    expect(await status(t, receipt.threadId)).toMatchObject({
      errorCode: "BUDGET_EXCEEDED",
      turnStatus: "recovery_required",
    });

    expect(fixture.calls).toHaveLength(1);

    expect(
      await t.run((ctx) => meter.threadCost(ctx, { threadId: receipt.threadId })),
    ).toMatchObject({
      totalNanos: 100_000_000,
    });
  },
);

it("unpriced usage fails closed at the next slice even without a budget cap", async () => {
  twoSteps();

  fixture.toolWork = async (tc) => {
    await tc.meter.record("openrouter", {});

    return "unknown cost";
  };

  const { t, meter } = setup();
  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBe("BUDGET_EXCEEDED");
  expect(fixture.calls).toHaveLength(1);

  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: receipt.threadId }))).toMatchObject(
    {
      unknown: 1,
    },
  );
});

it("estimated tool spend counts toward the next slice's budget gate", async () => {
  twoSteps();

  fixture.toolWork = async (tc) => {
    await tc.meter.estimate("fal", { profile: "image", quantity: 1 });

    return "reserved";
  };

  const { t, meter } = setup({ budgets: () => ({ maxUsd: 0.15 }) });
  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBe("BUDGET_EXCEEDED");
  expect(fixture.calls).toHaveLength(1);

  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: receipt.threadId }))).toMatchObject(
    {
      totalNanos: 350_000_000,
      estimatedNanos: 250_000_000,
      settledNanos: 100_000_000,
      unknown: 0,
    },
  );
});

it("a budget policy error fails closed before any model call", async () => {
  const { t } = setup({
    budgets: async () => {
      throw new Error("billing policy unavailable");
    },
  });

  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBe("BUDGET_EXCEEDED");
  expect(fixture.calls).toHaveLength(0);
});

it("core's hashed lifecycle keys replay the meter's original operation outcomes", async () => {
  twoSteps();

  fixture.toolWork = async (tc) => {
    const charge = await tc.meter.estimate("fal", { profile: "image", quantity: 4 });

    await charge.attach({ requestId: "image-request" });
    await charge.correct({ quantity: 3 });
    await charge.settle({ usd: 0.5 });

    return "settled";
  };

  const { t, meter, component } = setup();
  const receipt = await open(t);

  await drain(t);
  const key = await opaqueKey("charge", fixture.toolContext!.toolCallId, 0);

  await t.action(async (ctx) => {
    const replay = scopedMeter(
      meter.usageSlot().scope(ctx, facts()),
      fixture.toolContext!.toolCallId,
    );

    const charge = await replay.estimate("fal", { profile: "image", quantity: 4 });

    expect(await charge.attach({ requestId: "image-request" })).toMatchObject({
      status: "estimate",
      nanos: 1_000_000_000,
    });

    expect(await charge.correct({ quantity: 2 })).toMatchObject({
      status: "corrected",
      quantity: 3,
      nanos: 750_000_000,
    });

    expect(await charge.settle({ usd: 0.9 })).toMatchObject({
      status: "settled",
      nanos: 500_000_000,
    });
  });

  expect(await t.query(component.charges.get, { key })).toMatchObject({
    attribution: facts(),
    status: "settled",
    nanos: 500_000_000,
  });

  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: receipt.threadId }))).toMatchObject(
    {
      totalNanos: 700_000_000,
    },
  );
});
