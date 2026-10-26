import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import { LIMITS, polarSink, type Meter, type SinkEvent } from "../../src/meter/index.js";
import { deliveryJob } from "../../src/meter/component/contracts.js";
import { setup, attribution } from "./setup.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
});

afterEach(() => vi.useRealTimers());

const drain = (t: ReturnType<typeof setup>["t"]) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);

const cost = { openrouter: { usage: { cost: 0.1 } } };

it("a crashed delivery job counts one failed attempt for its claimed batch and the sink eventually fails", async () => {
  let runs = 0;
  const delivered: SinkEvent[] = [];

  const { t, meter, component } = setup(
    {
      limits: { maxAttempts: 2 },
      sinks: [{ name: "ledger", deliver: async (batch) => void delivered.push(...batch) }],
    },
    (functions, component) => ({
      ...functions,
      // The worker dies without reporting: first before claiming (it touched
      // nothing, so it is retried free), then twice after claiming its batch.
      meterDeliver: internalActionGeneric({
        args: deliveryJob,
        returns: v.null(),
        handler: async (ctx, args) => {
          if (runs++ > 0) await ctx.runMutation(component.charges.claimDeliveries, args);

          throw new Error("worker crashed");
        },
      }),
    }),
  );

  await t.run(async (ctx) => {
    await meter
      .scope(ctx, attribution)
      .record("openrouter", { key: "crash", providerMetadata: cost });
  });

  for (let round = 0; round < 3; round++) {
    await drain(t);
    await vi.advanceTimersByTimeAsync(LIMITS.maxBackoffMs);
  }

  expect(runs).toBe(3);
  expect(delivered).toHaveLength(0);

  expect((await t.query(component.charges.get, { key: "crash" }))?.sinkState[0]).toMatchObject({
    attempts: 2,
    failed: true,
    pending: { externalId: "crash" },
  });

  // Failure is terminal for scheduling: no job keeps retrying it.
  await vi.advanceTimersByTimeAsync(LIMITS.maxBackoffMs);
  await drain(t);
  expect(runs).toBe(3);
});

it("a 429 with Retry-After reschedules once without consuming an attempt and the next 429 consumes one", async () => {
  const calls: number[] = [];

  const { t, meter, component } = setup({
    limits: { maxAttempts: 1 },
    sinks: [
      polarSink({
        meter: "usage",
        accessToken: "test-token",
        fetch: async () => {
          calls.push(Date.now());

          return new Response(null, { status: 429, headers: { "Retry-After": "30" } });
        },
      }),
    ],
  });

  await t.run(async (ctx) => {
    await meter
      .scope(ctx, attribution)
      .record("openrouter", { key: "limited", providerMetadata: cost });
  });

  for (let round = 0; round < 3; round++) {
    await drain(t);
    await vi.advanceTimersByTimeAsync(LIMITS.maxBackoffMs);
  }

  // With one attempt, a consumed first 429 would stop after one request; a
  // 429 that never consumed attempts would keep sending every 30 seconds.
  expect(calls).toHaveLength(2);
  expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(30_000);

  expect((await t.query(component.charges.get, { key: "limited" }))?.sinkState[0]).toMatchObject({
    attempts: 1,
    failed: true,
  });
});

it("a job that acknowledged its batch and then died charges no other pending row", async () => {
  let runs = 0;
  let host: Meter | undefined;
  const delivered: SinkEvent[] = [];

  const { t, meter, component } = setup(
    {
      // One attempt: a single wrongly charged attempt would fail "later" for good.
      limits: { maxAttempts: 1 },
      sinks: [{ name: "ledger", deliver: async (batch) => void delivered.push(...batch) }],
    },
    (functions, component) => ({
      ...functions,
      meterDeliver: internalActionGeneric({
        args: deliveryJob,
        returns: v.null(),
        handler: async (ctx, args) => {
          if (runs++ > 0) {
            // Later jobs behave normally.
            const events = await ctx.runMutation(component.charges.claimDeliveries, args);

            if (!events.length) return null;

            await ctx.runMutation(component.charges.deliveryResult, {
              ...args,
              keys: events.map((event) => event.key),
              ok: true,
              rateLimited: false,
            });

            delivered.push(...events);

            return null;
          }

          // First job: claims and acknowledges "early", then another charge
          // becomes due, then the worker dies before returning.
          const events = await ctx.runMutation(component.charges.claimDeliveries, args);

          await ctx.runMutation(component.charges.deliveryResult, {
            ...args,
            keys: events.map((event) => event.key),
            ok: true,
            rateLimited: false,
          });

          await host!
            .scope(ctx, attribution)
            .record("openrouter", { key: "later", providerMetadata: cost });

          throw new Error("worker crashed");
        },
      }),
    }),
  );

  host = meter;

  await t.run(async (ctx) => {
    await meter
      .scope(ctx, attribution)
      .record("openrouter", { key: "early", providerMetadata: cost });
  });

  for (let round = 0; round < 3; round++) {
    await drain(t);
    await vi.advanceTimersByTimeAsync(LIMITS.maxBackoffMs);
  }

  for (const key of ["early", "later"])
    expect((await t.query(component.charges.get, { key }))?.sinkState[0]).toMatchObject({
      deliveredNanos: 100_000_000,
      attempts: 0,
      failed: false,
    });

  expect(delivered.map((event) => event.externalId)).toEqual(["later"]);
});

it("a delivery worker that always dies before claiming still drives its rows to failed", async () => {
  let runs = 0;

  const { t, meter, component } = setup(
    {
      limits: { maxAttempts: 2 },
      sinks: [{ name: "ledger", deliver: async () => {} }],
    },
    (functions) => ({
      ...functions,
      // E.g. a broken worker export after a deploy: it never reaches the claim.
      meterDeliver: internalActionGeneric({
        args: deliveryJob,
        returns: v.null(),
        handler: async () => {
          runs++;
          throw new Error("worker broken");
        },
      }),
    }),
  );

  await t.run(async (ctx) => {
    await meter
      .scope(ctx, attribution)
      .record("openrouter", { key: "stuck", providerMetadata: cost });
  });

  for (let round = 0; round < 8; round++) {
    await drain(t);
    await vi.advanceTimersByTimeAsync(LIMITS.maxBackoffMs);
  }

  expect((await t.query(component.charges.get, { key: "stuck" }))?.sinkState[0]).toMatchObject({
    attempts: 2,
    failed: true,
  });

  // Two cycles of (free retry, charged crash), then no job keeps running.
  expect(runs).toBe(4);
});
