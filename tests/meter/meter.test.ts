import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  usageHandlerFor,
  LIMITS,
  observeProviderOutcome,
  type SinkEvent,
} from "../../src/meter/index.js";
import { setup, attribution, allBreakdowns } from "./setup.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});
const drain = (t: ReturnType<typeof setup>["t"]) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);

it("settlement survives replayed corrections and estimates, including concurrent correction", async () => {
  const { t, meter, component } = setup();
  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "precedence",
      profile: "image",
      quantity: 4,
    });
    await charge.correct({ quantity: 3 });
    await charge.settle({ usd: 0.5 });
    await charge.correct({ quantity: 3 });
    expect(await charge.get()).toMatchObject({ status: "settled", nanos: 500_000_000 });
  });
  await t.run(async (ctx) => {
    await meter.scope(ctx, attribution).estimate("fal", {
      key: "precedence",
      profile: "image",
      quantity: 4,
    });
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "race",
      profile: "image",
      quantity: 4,
    });
    await Promise.all([charge.correct({ quantity: 3 }), charge.settle({ usd: 0.5 })]);
    expect(await charge.get()).toMatchObject({ status: "settled", nanos: 500_000_000 });
  });
  expect(await t.query(component.charges.get, { key: "precedence" })).toMatchObject({
    status: "settled",
    nanos: 500_000_000,
    lastStale: { operation: "estimate" },
  });
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    settledNanos: 1_000_000_000,
    estimatedNanos: 0,
  });
});

it("a replayed correction revision cannot overwrite a newer correction", async () => {
  const { t, meter } = setup();
  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "revision",
      profile: "image",
      quantity: 4,
    });
    await charge.correct({ quantity: 3, revision: 0 });
    await charge.correct({ quantity: 2, revision: 1 });
    await charge.correct({ quantity: 3, revision: 0 });
    const before = await charge.get();
    expect(before).toMatchObject({ status: "corrected", nanos: 500_000_000, revision: 2 });
    await charge.correct({ quantity: 3, revision: 0 });
    expect(await charge.get()).toEqual(before);
  });
});

it("expired unknown rejects corrections but accepts a late real provider result exactly once", async () => {
  const { t, meter, component } = setup({
    providers: {
      async: {
        profiles: { image: { unit: "image", usd: 0.25 } },
        lookup: async () => undefined,
        lookupFor: LIMITS.backoffMs,
      },
    },
  });
  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("async", {
      key: "late",
      profile: "image",
      quantity: 4,
    });
    await charge.attach({ requestId: "late-request" });
  });
  await vi.advanceTimersByTimeAsync(LIMITS.backoffMs);
  await drain(t);
  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("async", {
      key: "late",
      profile: "image",
      quantity: 4,
    });
    await charge.correct({ quantity: 3 });
    expect(await charge.get()).toMatchObject({ status: "unknown", nanos: 1_000_000_000 });
  });
  const row = (await t.query(component.charges.get, { key: "late" }))!;
  const result = {
    key: "late",
    provider: "async",
    requestId: "late-request",
    until: row.lookupUntil!,
    attempt: 0,
    jobs: { maxAttempts: LIMITS.maxAttempts },
    nanos: 500_000_000,
  };
  await t.mutation(component.charges.lookupResult, result);
  const settled = await t.query(component.charges.get, { key: "late" });
  await t.mutation(component.charges.lookupResult, result);
  expect(await t.query(component.charges.get, { key: "late" })).toEqual(settled);
  expect(settled).toMatchObject({ status: "settled", source: "lookup", nanos: 500_000_000 });
});

it("thread axes include root and children across agents models providers and unknowns", async () => {
  const { t, meter } = setup({ breakdowns: allBreakdowns });
  await t.run(async (ctx) => {
    const root = meter.scope(ctx, { ...attribution, threadId: "root", agent: "A", model: "M1" });
    await root.record("openrouter", {
      key: "root-axis",
      providerMetadata: { openrouter: { usage: { cost: 0.5 } } },
    });
    await meter.scope(ctx, { ...attribution, agent: "B", model: "M2" }).estimate("fal", {
      key: "child-axis",
      profile: "image",
      quantity: 3,
    });
    await meter
      .scope(ctx, { ...attribution, threadId: "child2", agent: "A", model: "M2" })
      .record("firecrawl", { key: "unknown-axis" });
    await meter
      .scope(ctx, { ...attribution, rootThreadId: "other", agent: "A", model: "M1" })
      .record("openrouter", {
        key: "other-axis",
        providerMetadata: { openrouter: { usage: { cost: 9 } } },
      });
  });
  const cost = await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }));
  expect(cost).toMatchObject({
    settledNanos: 500_000_000,
    estimatedNanos: 750_000_000,
    unknown: 1,
    byAgent: {
      page: [
        { key: "A", settledNanos: 500_000_000, unknown: 1 },
        { key: "B", estimatedNanos: 750_000_000 },
      ],
      cursor: null,
    },
    byModel: {
      page: [
        { key: "M1", settledNanos: 500_000_000 },
        { key: "M2", estimatedNanos: 750_000_000, unknown: 1 },
      ],
      cursor: null,
    },
    byProvider: {
      page: [
        { key: "fal", estimatedNanos: 750_000_000 },
        { key: "firecrawl", unknown: 1 },
        { key: "openrouter", settledNanos: 500_000_000 },
      ],
      cursor: null,
    },
  });
});

it("idempotent inline recording preserves exactly one settled charge including a zero cost", async () => {
  const { t, meter, component } = setup({ breakdowns: allBreakdowns });
  for (let attempt = 0; attempt < 2; attempt++)
    await t.run(async (ctx) => {
      await meter.scope(ctx, attribution).record("openrouter", {
        key: "saved-step",
        providerMetadata: { openrouter: { usage: { cost: 0 } } },
      });
    });
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    settledNanos: 0,
    unknown: 0,
  });
  expect(await t.query(component.charges.get, { key: "saved-step" })).toMatchObject({
    status: "settled",
    source: "inline",
    nanos: 0,
  });
  const day = Math.floor(Date.now() / LIMITS.dayMs) * LIMITS.dayMs;
  expect(
    (
      await t.run((ctx) =>
        meter.breakdown(ctx, {
          subject: "owner",
          from: day,
          to: day + LIMITS.dayMs,
          by: "provider",
        }),
      )
    ).page,
  ).toHaveLength(1);
  await expect(
    t.run(async (ctx) => {
      await meter
        .scope(ctx, { ...attribution, subject: "other" })
        .record("openrouter", { key: "saved-step" });
    }),
  ).rejects.toThrow("KEY_CONFLICT");
});

it("estimate then quantity correction then settlement replaces thread and run totals exactly once", async () => {
  const { t, meter } = setup();
  const estimate = async () =>
    await t.run(async (ctx) => {
      await meter
        .scope(ctx, attribution)
        .estimate("fal", { key: "image", profile: "image", quantity: 6 });
    });
  await estimate();
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    totalNanos: 1_500_000_000,
  });
  await t.run(async (ctx) => {
    const handle = await meter
      .scope(ctx, attribution)
      .estimate("fal", { key: "image", profile: "image", quantity: 6 });
    await handle.correct({ quantity: 5 });
    await handle.correct({ quantity: 5 });
  });
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    totalNanos: 1_250_000_000,
  });
  await t.run(async (ctx) => {
    const handle = await meter
      .scope(ctx, attribution)
      .estimate("fal", { key: "image", profile: "image", quantity: 6 });
    await handle.settle({ usd: 1.1 });
    await handle.settle({ usd: 1.1 });
  });
  expect(
    await t.run((ctx) => meter.subjectCost(ctx, { subject: "owner", runId: "run" })),
  ).toMatchObject({ totalNanos: 1_100_000_000, estimatedNanos: 0, settledNanos: 1_100_000_000 });
  await t.run(async (ctx) => {
    await meter.scope(ctx, { ...attribution, threadId: "child-two" }).record("openrouter", {
      key: "child-step",
      providerMetadata: { openrouter: { usage: { cost: 0.2 } } },
    });
  });
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    totalNanos: 1_300_000_000,
  });
});

it("unknown cost remains visible and denies admission rather than being treated as free", async () => {
  const { t, meter } = setup();
  await t.run(async (ctx) => {
    await meter.scope(ctx, attribution).record("openrouter", { key: "missing-evidence" });
  });
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    unknown: 1,
  });
  expect(await t.run((ctx) => meter.check(ctx, { subject: "owner", runId: "run" }))).toMatchObject({
    allowed: false,
    unknown: 1,
  });
  await t.run(async (ctx) => {
    const charge = await meter
      .scope(ctx, attribution)
      .record("openrouter", { key: "missing-evidence" });
    await charge.settle({ usd: 0 });
  });
  expect(await t.run((ctx) => meter.check(ctx, { subject: "owner", runId: "run" }))).toMatchObject({
    allowed: true,
    unknown: 0,
  });
});

it("budget checks count estimates and isolate runs and subjects", async () => {
  const { t, meter } = setup({ budgets: () => ({ maxUsd: 1 }) });
  await t.run(async (ctx) => {
    await meter
      .scope(ctx, attribution)
      .estimate("fal", { key: "reservation", profile: "image", quantity: 5 });
  });
  expect(await t.run((ctx) => meter.check(ctx, { subject: "owner", runId: "run" }))).toMatchObject({
    allowed: false,
    totalNanos: 1_250_000_000,
  });
  expect(
    await t.run((ctx) => meter.check(ctx, { subject: "owner", runId: "other" })),
  ).toMatchObject({ allowed: true, totalNanos: 0 });
  expect(await t.run((ctx) => meter.check(ctx, { subject: "other" }))).toMatchObject({
    allowed: true,
    totalNanos: 0,
  });
});

it("breakdowns cover each axis with UTC ranges and bounded continuation pages", async () => {
  const { t, meter } = setup({ breakdowns: allBreakdowns });
  const start = Date.now();
  for (let index = 0; index < LIMITS.maxGroups + 1; index++)
    await t.run(async (ctx) => {
      await meter
        .scope(ctx, { ...attribution, agent: `agent${index}`, model: `model${index}` })
        .record("openrouter", {
          key: `step${index}`,
          providerMetadata: { openrouter: { usage: { cost: 0.1 } } },
        });
    });
  vi.setSystemTime(start + LIMITS.dayMs);
  await t.run(async (ctx) => {
    const charge = await meter
      .scope(ctx, attribution)
      .estimate("fal", { key: "later", profile: "image", quantity: 2 });
    await charge.settle({ usd: 0.5 });
  });
  const range = { subject: "owner", from: start, to: start + LIMITS.dayMs };
  const days = await t.run((ctx) =>
    meter.breakdown(ctx, { ...range, to: start + 2 * LIMITS.dayMs, by: "day" }),
  );
  expect(days.page.map((row) => row.totalNanos)).toEqual([500_000_000, 500_000_000]);
  for (const by of ["agent", "model"] as const) {
    const first = await t.run((ctx) => meter.breakdown(ctx, { ...range, by }));
    expect(first.page).toHaveLength(LIMITS.maxGroups);
    expect(first.cursor).not.toBeNull();
    const next = await t.run((ctx) =>
      meter.breakdown(ctx, { ...range, by, cursor: first.cursor! }),
    );
    expect([...first.page, ...next.page].reduce((sum, row) => sum + row.totalNanos, 0)).toBe(
      500_000_000,
    );
    expect(next.cursor).toBeNull();
  }
  const providers = await t.run((ctx) => meter.breakdown(ctx, { ...range, by: "provider" }));
  expect(providers.page.find((row) => row.key === "openrouter")?.settledNanos).toBe(500_000_000);
  expect(providers.page.find((row) => row.key === "fal")?.totalNanos).toBe(0);
  await expect(
    t.run((ctx) => meter.breakdown(ctx, { ...range, from: start + 1, by: "day" })),
  ).rejects.toThrow("DAY_BOUNDARIES_REQUIRED");
});

it("request-id lookup resolves with backoff without repeating a paid operation", async () => {
  let lookups = 0;
  const { t, meter, component } = setup({
    providers: {
      async: {
        profiles: { request: { unit: "call", usd: 0.3 } },
        lookupFor: LIMITS.backoffMs * 20,
        lookup: async (_ctx, id) => {
          expect(id).toBe("provider-id");
          return ++lookups === 1 ? undefined : { usd: 0.2 };
        },
      },
    },
  });
  await t.run(async (ctx) => {
    const charge = await meter
      .scope(ctx, attribution)
      .estimate("async", { key: "lookup", profile: "request", quantity: 1 });
    await charge.attach({ requestId: "provider-id" });
    await charge.attach({ requestId: "provider-id" });
  });
  await drain(t);
  expect(lookups).toBe(2);
  expect(await t.query(component.charges.get, { key: "lookup" })).toMatchObject({
    status: "settled",
    source: "lookup",
    nanos: 200_000_000,
  });
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    totalNanos: 200_000_000,
    unknown: 0,
  });
});

it("lookup expiry retains its last estimate and counts unknown even after retry exhaustion", async () => {
  const lookup = vi.fn(async () => undefined);
  const { t, meter } = setup({
    providers: {
      async: {
        profiles: { request: { unit: "call", usd: 0.3 } },
        lookupFor: LIMITS.backoffMs * 20,
        lookup,
      },
    },
    limits: { maxAttempts: 1 },
  });
  await t.run(async (ctx) => {
    const charge = await meter
      .scope(ctx, attribution)
      .estimate("async", { key: "expires", profile: "request", quantity: 1 });
    await charge.attach({ requestId: "missing" });
  });
  await drain(t);
  expect(lookup).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(LIMITS.backoffMs * 20);
  await drain(t);
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    unknown: 1,
    unknownNanos: 300_000_000,
  });
  const before = lookup.mock.calls.length;
  await drain(t);
  expect(lookup).toHaveBeenCalledTimes(before);
});

it("sink failure cannot roll back recording and retries preserve the event identity", async () => {
  const attempts: SinkEvent[] = [];
  const { t, meter, component } = setup({
    sinks: [
      {
        name: "ledger",
        deliver: async (batch) => {
          attempts.push(...batch);
          if (attempts.length === 1) throw new Error("sink offline");
        },
      },
    ],
  });
  await t.run(async (ctx) => {
    await meter.scope(ctx, attribution).record("openrouter", {
      key: "sink",
      providerMetadata: { openrouter: { usage: { cost: 0.1 } } },
    });
  });
  expect(await t.query(component.charges.get, { key: "sink" })).toMatchObject({
    status: "settled",
  });
  await drain(t);
  expect(attempts).toHaveLength(2);
  expect(attempts.map((e) => e.externalId)).toEqual(["sink", "sink"]);
  expect((await t.query(component.charges.get, { key: "sink" }))?.sinkState[0].deliveredNanos).toBe(
    100_000_000,
  );
});

it("settlement after a delivered correction sends a signed delta and cannot double bill", async () => {
  const events: SinkEvent[] = [];
  const { t, meter } = setup({
    sinks: [
      {
        name: "ledger",
        deliver: async (batch) => {
          events.push(...batch);
        },
      },
    ],
  });
  const settle = async (usd: number) =>
    await t.run(async (ctx) => {
      const charge = await meter.scope(ctx, attribution).estimate("fal", {
        key: "delta",
        profile: "image",
        quantity: 4,
      });
      await charge.settle({ usd });
    });
  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "delta",
      profile: "image",
      quantity: 4,
    });
    await charge.correct({ quantity: 2 });
  });
  await drain(t);
  await settle(0.3);
  await drain(t);
  await settle(0.3);
  await drain(t);
  expect(events.map((e) => [e.externalId, e.nanos])).toEqual([
    ["delta", 500_000_000],
    ["delta:delta:2", -200_000_000],
  ]);
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    totalNanos: 300_000_000,
  });
});

it("a correction during delivery retains the immutable event until acknowledgement", async () => {
  const events: SinkEvent[] = [];
  let mutate: (() => Promise<void>) | undefined;
  const { t, meter } = setup({
    sinks: [
      {
        name: "ledger",
        deliver: async (batch) => {
          events.push(...batch);
          if (mutate) {
            const once = mutate;
            mutate = undefined;
            await once();
          }
        },
      },
    ],
  });
  mutate = async () => {
    await t.run(async (ctx) => {
      const charge = await meter
        .scope(ctx, attribution)
        .estimate("fal", { key: "inflight", profile: "image", quantity: 4 });
      await charge.settle({ usd: 0.2 });
    });
  };
  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "inflight",
      profile: "image",
      quantity: 4,
    });
    await charge.correct({ quantity: 2 });
  });
  await drain(t);
  expect(events.map((e) => e.nanos)).toEqual([500_000_000, -300_000_000]);
});

it("usageHandlerFor records the same saved step once and distinct steps separately", async () => {
  const { t, meter } = setup();
  let step = 0;
  const handler = usageHandlerFor(meter, {
    provider: "openrouter",
    identity: () => ({ subject: "owner", messageId: "message", step }),
  });
  const args = {
    userId: "owner",
    threadId: "root",
    agentName: "Builder",
    model: "model",
    provider: "openrouter",
    usage: {} as Parameters<typeof handler>[1]["usage"],
    providerMetadata: { openrouter: { usage: { cost: 0.1 } } },
  };
  await t.action(async (ctx) => {
    await handler(ctx, args);
    await handler(ctx, args);
    step++;
    await handler(ctx, args);
  });
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    totalNanos: 200_000_000,
  });
});

it("credit settlement uses the registered rate and missing rates cannot invent money", async () => {
  const { t, meter } = setup();
  await t.run(async (ctx) => {
    const charge = await meter
      .scope(ctx, attribution)
      .estimate("firecrawl", { key: "credits", quantity: 1 });
    await charge.settle({ credits: 3 });
    expect(await charge.get()).toMatchObject({ credits: 3, nanos: 3_000_000, status: "settled" });
  });
  await expect(
    t.run(async (ctx) => {
      const charge = await meter.scope(ctx, attribution).estimate("fal", {
        key: "no-credit-rate",
        profile: "image",
        quantity: 1,
      });
      await charge.settle({ credits: 3 });
    }),
  ).rejects.toThrow("CREDIT_RATE_REQUIRED");
  expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).toMatchObject({
    unknown: 0,
    settledNanos: 3_000_000,
  });
});

it("registration and public inputs reject unbounded or invalid overrides", async () => {
  expect(() => setup({ limits: { maxGroups: LIMITS.maxGroups + 1 } })).toThrow("INVALID_LIMIT");
  expect(() => setup({ providers: { invalid: { credits: { usdPerCredit: NaN } } } })).toThrow(
    "INVALID_USD",
  );
  expect(() =>
    setup({ providers: { lookup: { lookup: async () => undefined } }, workers: {} }),
  ).toThrow("LOOKUP_WORKER_REQUIRED");
  const { t, meter } = setup({ limits: { maxCharges: 1 } });
  await expect(
    t.run(async (ctx) => {
      await meter
        .scope(ctx, attribution)
        .estimate("fal", { key: "invalid", profile: "image", quantity: Infinity });
    }),
  ).rejects.toThrow("INVALID_QUANTITY");
  await t.run(async (ctx) => {
    await meter
      .scope(ctx, attribution)
      .estimate("fal", { key: "one", profile: "image", quantity: 1 });
  });
  await expect(
    t.run(async (ctx) => {
      await meter
        .scope(ctx, attribution)
        .estimate("fal", { key: "two", profile: "image", quantity: 1 });
    }),
  ).rejects.toThrow("METER_CAPACITY");
});

it("host authorization runs for writes and reads before component access", async () => {
  const authorize = vi.fn(async () => {
    throw new Error("DENIED");
  });
  const { t, meter } = setup({ authorize });
  await expect(
    t.run(async (ctx) => {
      await meter.scope(ctx, attribution).record("openrouter", { key: "denied" });
    }),
  ).rejects.toThrow("DENIED");
  await expect(t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }))).rejects.toThrow(
    "DENIED",
  );
  expect(authorize).toHaveBeenCalledTimes(2);
});

it("base charge keys cannot collide with an existing correction event id", async () => {
  const { t, meter } = setup();
  await expect(
    t.run(async (ctx) => {
      await meter.scope(ctx, attribution).record("openrouter", { key: "charge:delta:2" });
    }),
  ).rejects.toThrow("RESERVED_CHARGE_KEY");
});

it("corrected estimates can still resolve through their attached provider request", async () => {
  const { t, meter, component } = setup({
    providers: {
      async: {
        profiles: { request: { unit: "call", usd: 0.3 } },
        lookupFor: LIMITS.backoffMs * 20,
        lookup: async () => ({ usd: 0.15 }),
      },
    },
  });
  await t.run(async (ctx) => {
    const charge = await meter
      .scope(ctx, attribution)
      .estimate("async", { key: "corrected-lookup", profile: "request", quantity: 2 });
    await charge.correct({ quantity: 1 });
    await charge.attach({ requestId: "corrected-id" });
  });
  await drain(t);
  expect(await t.query(component.charges.get, { key: "corrected-lookup" })).toMatchObject({
    status: "settled",
    source: "lookup",
    nanos: 150_000_000,
  });
});

it("credit lookups retain provider units alongside their converted nanodollar cost", async () => {
  const { t, meter, component } = setup({
    providers: {
      async: {
        credits: { usdPerCredit: 0.001 },
        lookupFor: LIMITS.backoffMs * 20,
        lookup: async () => ({ credits: 3 }),
      },
    },
  });
  await t.run(async (ctx) => {
    const charge = await meter
      .scope(ctx, attribution)
      .estimate("async", { key: "lookup-credits", quantity: 1 });
    await charge.attach({ requestId: "credit-id" });
  });
  await drain(t);
  expect(await t.query(component.charges.get, { key: "lookup-credits" })).toMatchObject({
    status: "settled",
    source: "lookup",
    nanos: 3_000_000,
    credits: 3,
  });
});

it("exhausted sink delivery stops scheduling and explicit recovery reuses the uncertain event id", async () => {
  const attempts: string[] = [];
  let offline = true;
  const { t, meter, component } = setup({
    limits: { maxAttempts: 2 },
    sinks: [
      {
        deliver: async (batch) => {
          attempts.push(batch[0].externalId);
          if (offline) throw new Error("offline");
        },
      },
    ],
  });
  await t.run(async (ctx) => {
    await meter.scope(ctx, attribution).record("openrouter", {
      key: "recover",
      providerMetadata: { openrouter: { usage: { cost: 0.1 } } },
    });
  });
  await drain(t);
  await vi.advanceTimersByTimeAsync(LIMITS.maxBackoffMs);
  await drain(t);
  expect(attempts).toEqual(["recover", "recover"]);
  expect((await t.query(component.charges.get, { key: "recover" }))?.sinkState[0].failed).toBe(
    true,
  );
  await vi.advanceTimersByTimeAsync(LIMITS.maxBackoffMs);
  await drain(t);
  expect(attempts).toHaveLength(2);
  offline = false;
  await t.run((ctx) => meter.retrySinks(ctx, { key: "recover", subject: "owner" }));
  await drain(t);
  expect(attempts).toEqual(["recover", "recover", "recover"]);
  expect(
    (await t.query(component.charges.get, { key: "recover" }))?.sinkState[0].deliveredNanos,
  ).toBe(100_000_000);
});

it("billing observation failures preserve both successful results and original provider errors", async () => {
  const original = new Error("provider");
  expect(
    await observeProviderOutcome({
      invoke: async () => "result",
      onSuccess: () => {
        throw new Error("decode");
      },
    }),
  ).toBe("result");
  await expect(
    observeProviderOutcome({
      invoke: async () => {
        throw original;
      },
      onSuccess: () => {},
      onFailure: () => {
        throw new Error("evidence");
      },
    }),
  ).rejects.toBe(original);
});
