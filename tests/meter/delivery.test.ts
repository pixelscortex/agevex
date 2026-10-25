import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import { LIMITS, polarSink, type SinkEvent } from "../../src/meter/index.js";
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

it("a crashed delivery job counts as one failed attempt and the sink eventually fails", async () => {
  let runs = 0;
  const delivered: SinkEvent[] = [];
  const { t, meter, component } = setup(
    {
      limits: { maxAttempts: 2 },
      sinks: [{ name: "ledger", deliver: async (batch) => void delivered.push(...batch) }],
    },
    (functions, component) => ({
      ...functions,
      // The worker dies without reporting: first before claiming its batch,
      // then after claiming it, as an action timeout or process loss would.
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
  await drain(t);
  await vi.advanceTimersByTimeAsync(LIMITS.maxBackoffMs);
  await drain(t);
  expect(runs).toBe(2);
  expect(delivered).toHaveLength(0);
  expect((await t.query(component.charges.get, { key: "crash" }))?.sinkState[0]).toMatchObject({
    attempts: 2,
    failed: true,
    pending: { externalId: "crash" },
  });
  // Failure is terminal for scheduling: no job keeps retrying it.
  await vi.advanceTimersByTimeAsync(LIMITS.maxBackoffMs);
  await drain(t);
  expect(runs).toBe(2);
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
