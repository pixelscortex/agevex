/** Fake host sinks exercise context, frozen classifications and replay through real workers. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import {
  defineMeter,
  inline,
  LIMITS,
  type Sink,
  type SinkEvent,
} from "../../src/modules/meter/client/index.js";
import { register } from "../../src/modules/meter/test.js";
import receiptSchema from "./fixture/receipt-schema.js";
import { setup, attribution } from "./setup.js";

const receive = makeFunctionReference("sink:receive") as unknown as FunctionReference<
  "mutation",
  "internal",
  { event: Omit<SinkEvent, "key" | "attribution" | "provider"> },
  null
>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
});

afterEach(() => vi.useRealTimers());

/** Drive on-demand Workpool delivery, including its bounded retries. */
function drain(t: Pick<ReturnType<typeof setup>["t"], "finishAllScheduledFunctions">) {
  return t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);
}

/** Isolate the host receipt table from tests whose host has an empty data model. */
function setupReceipts(sink: Sink) {
  const t = convexTest({
    schema: receiptSchema,
    transactionLimits: true,
    modules: {
      ...import.meta.glob("./fixture/**/*.ts"),
      "./fixture/host.ts": async (): Promise<object> => meter.internalFunctions(),
    },
  });

  const component = register(t);

  const meter = defineMeter(component, {
    providers: { openrouter: inline() },
    sinks: [sink],
    workers: {
      deliver: makeFunctionReference("host:meterDeliver") as unknown as FunctionReference<
        "action",
        "internal"
      >,
    },
  });

  return { t, meter };
}

it("delivery receives the host action context and uncertain acknowledgement replays one host receipt", async () => {
  const attempts: SinkEvent[] = [];

  const { t, meter } = setupReceipts({
    deliver: async (batch, ctx) => {
      for (const entry of batch) {
        const { key: _key, attribution: _attribution, provider: _provider, ...event } = entry;

        await ctx.runMutation(receive, { event });
        attempts.push(entry);
      }

      // The recipient committed, but the worker cannot know the outcome.
      if (attempts.length === 1) throw new Error("acknowledgement lost");
    },
  });

  const record = () =>
    t.run(async (ctx) => {
      await meter.scope(ctx, attribution).record("openrouter", {
        key: "host-context",
        providerMetadata: { openrouter: { usage: { cost: 0.1 } } },
      });
    });

  await record();
  await drain(t);
  await record();
  await drain(t);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0]).toMatchObject({ externalId: "host-context", revision: 1 });
  const receipts = await t.run((ctx) => ctx.db.query("sinkReceipts").take(LIMITS.sinkBatch));

  expect(receipts).toHaveLength(1);

  expect(receipts[0]).toMatchObject({
    externalId: "host-context",
    revision: 1,
    totalNanos: 100_000_000,
    status: "settled",
    source: "inline",
  });
});

it("initial estimates reach only opted-in sinks and same-amount settlement advances classification", async () => {
  const live: SinkEvent[] = [];
  const defaults: SinkEvent[] = [];

  const { t, meter } = setup({
    sinks: [
      { name: "live", estimates: true, deliver: async (batch) => void live.push(...batch) },
      { name: "default", deliver: async (batch) => void defaults.push(...batch) },
    ],
  });

  const estimate = () =>
    t.run(async (ctx) => {
      await meter.scope(ctx, attribution).estimate("fal", {
        key: "classification",
        profile: "image",
        quantity: 1,
      });
    });

  await estimate();
  await drain(t);
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ status: "estimate", source: "estimate", revision: 1 });
  expect(defaults).toEqual([]);

  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "classification",
      profile: "image",
      quantity: 1,
    });

    await charge.settle({ usd: 0.25, key: "same-amount" });
  });

  await drain(t);
  expect(live).toHaveLength(2);

  expect(live[1]).toMatchObject({
    externalId: "classification:delta:2",
    revision: 2,
    nanos: 0,
    totalNanos: 250_000_000,
    status: "settled",
    source: "settlement",
  });

  expect(defaults).toHaveLength(1);

  expect(defaults[0]).toMatchObject({
    externalId: "classification",
    revision: 1,
    nanos: 250_000_000,
    status: "settled",
    source: "settlement",
  });
});

it("event amount and classification stay frozen when the charge settles before delivery", async () => {
  const events: SinkEvent[] = [];

  const { t, meter } = setup({
    sinks: [{ estimates: true, deliver: async (batch) => void events.push(...batch) }],
  });

  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "frozen",
      profile: "image",
      quantity: 1,
    });

    await charge.settle({ usd: 0.25, key: "settle-before-delivery" });
    expect(await charge.get()).toMatchObject({ status: "settled", source: "settlement" });
  });

  await drain(t);

  expect(
    events.map(({ externalId, revision, status, source, nanos, totalNanos }) => ({
      externalId,
      revision,
      status,
      source,
      nanos,
      totalNanos,
    })),
  ).toEqual([
    {
      externalId: "frozen",
      revision: 1,
      status: "estimate",
      source: "estimate",
      nanos: 250_000_000,
      totalNanos: 250_000_000,
    },
    {
      externalId: "frozen:delta:2",
      revision: 2,
      status: "settled",
      source: "settlement",
      nanos: 0,
      totalNanos: 250_000_000,
    },
  ]);
});

it.each(["lookup", "exhausted"] as const)(
  "recorded token estimates survive %s without duplicate amounts",
  async (outcome) => {
    const events: SinkEvent[] = [];
    const defaults: SinkEvent[] = [];

    const { t, meter } = setup({
      providers: {
        tokens: {
          estimate: () => ({ usd: 0.25 }),
          lookup: async () => (outcome === "lookup" ? { usd: 0.25 } : undefined),
          lookupFor: LIMITS.deliveryWindowMs,
        },
      },
      sinks: [
        { estimates: true, deliver: async (batch) => void events.push(...batch) },
        { deliver: async (batch) => void defaults.push(...batch) },
      ],
    });

    await t.run(async (ctx) => {
      await meter.scope(ctx, attribution).record("tokens", {
        key: "token-estimate",
        requestId: "request",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      await meter.reconcile(ctx, { subject: attribution.subject, runId: attribution.runId });
    });

    await drain(t);

    expect(
      events.map((entry) => [entry.status, entry.source, entry.nanos, entry.revision]),
    ).toEqual(
      outcome === "lookup"
        ? [
            ["estimate", "estimate", 250_000_000, 1],
            ["settled", "lookup", 0, 2],
          ]
        : [["estimate", "estimate", 250_000_000, 1]],
    );

    expect(defaults.map((entry) => entry.source)).toEqual(outcome === "lookup" ? ["lookup"] : []);
  },
);

it("opted-in corrections advance status at the same amount and retain signed replacement deltas", async () => {
  const events: SinkEvent[] = [];

  const { t, meter } = setup({
    sinks: [{ estimates: true, deliver: async (batch) => void events.push(...batch) }],
  });

  for (const quantity of [2, 2, 1]) {
    await t.run(async (ctx) => {
      const charge = await meter.scope(ctx, attribution).estimate("fal", {
        key: "correction",
        profile: "image",
        quantity: 2,
      });

      if (events.length) await charge.correct({ quantity, key: `quantity-${quantity}` });
    });

    await drain(t);
  }

  expect(
    events.map((entry) => [
      entry.status,
      entry.source,
      entry.nanos,
      entry.totalNanos,
      entry.revision,
    ]),
  ).toEqual([
    ["estimate", "estimate", 500_000_000, 500_000_000, 1],
    ["corrected", "estimate", 0, 500_000_000, 2],
    ["corrected", "estimate", -250_000_000, 250_000_000, 3],
  ]);
});
