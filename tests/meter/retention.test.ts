import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { LIMITS } from "../../src/meter/index.js";
import { setup, attribution, allBreakdowns } from "./setup.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
});

afterEach(() => vi.useRealTimers());

const drain = (t: ReturnType<typeof setup>["t"]) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);

const cost = (usd: number) => ({ openrouter: { usage: { cost: usd } } });

it("prune deletes only settled, fully delivered charges before the cutoff, honours limit and keeps remaining totals exact", async () => {
  let offline = false;

  const { t, meter, component } = setup({
    breakdowns: allBreakdowns,
    // The age guard is tested separately; this test prunes a just-past cutoff.
    limits: { maxAttempts: 1, pruneMinAgeMs: 1 },
    sinks: [
      {
        name: "ledger",
        deliver: async () => {
          if (offline) throw new Error("offline");
        },
      },
    ],
  });

  const record = (key: string, usd?: number) =>
    t.run(async (ctx) => {
      await meter.scope(ctx, attribution).record("openrouter", {
        key,
        ...(usd === undefined ? {} : { providerMetadata: cost(usd) }),
      });
    });

  for (const key of ["old-1", "old-2", "old-3"]) await record(key, 0.1);

  await t.run(async (ctx) => {
    await meter
      .scope(ctx, attribution)
      .estimate("fal", { key: "estimate", profile: "image", quantity: 1 });
  });

  await record("unknown");
  await drain(t);
  offline = true;
  await record("undelivered", 0.2);
  await drain(t);

  expect((await t.query(component.charges.get, { key: "undelivered" }))?.sinkState[0].failed).toBe(
    true,
  );

  const before = Date.now() + 1;

  await vi.advanceTimersByTimeAsync(LIMITS.backoffMs);
  offline = false;
  await record("recent", 0.3);
  await drain(t);

  const prune = (limit?: number) =>
    t.run((ctx) => meter.prune(ctx, { before, ...(limit === undefined ? {} : { limit }) }));

  expect(await prune(2)).toEqual({ deleted: 2, more: true });
  expect(await prune()).toEqual({ deleted: 1, more: false });
  expect(await prune()).toEqual({ deleted: 0, more: false });

  for (const key of ["old-1", "old-2", "old-3"])
    expect(await t.query(component.charges.get, { key })).toBeNull();

  for (const key of ["estimate", "unknown", "undelivered", "recent"])
    expect(await t.query(component.charges.get, { key })).not.toBeNull();

  const remaining = {
    settledNanos: 500_000_000,
    estimatedNanos: 250_000_000,
    unknown: 1,
  };

  expect(await t.run((ctx) => meter.subjectCost(ctx, { subject: "owner" }))).toMatchObject(
    remaining,
  );

  expect(
    await t.run((ctx) => meter.subjectCost(ctx, { subject: "owner", runId: "run" })),
  ).toMatchObject(remaining);

  const thread = await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }));

  expect(thread).toMatchObject(remaining);

  expect(thread.byProvider?.page).toEqual([
    expect.objectContaining({ key: "fal", estimatedNanos: 250_000_000 }),
    expect.objectContaining({ key: "openrouter", settledNanos: 500_000_000, unknown: 1 }),
  ]);

  const day = Math.floor(Date.now() / LIMITS.dayMs) * LIMITS.dayMs;

  const models = await t.run((ctx) =>
    meter.breakdown(ctx, { subject: "owner", from: day, to: day + LIMITS.dayMs, by: "model" }),
  );

  expect(models.page).toEqual([expect.objectContaining({ key: "model", ...remaining })]);
});

it("prune refuses a cutoff inside the minimum age so active run and budget totals cannot drop", async () => {
  const { t, meter } = setup();

  await t.run(async (ctx) => {
    await meter
      .scope(ctx, attribution)
      .record("openrouter", { key: "live", providerMetadata: cost(0.1) });
  });

  await expect(t.run((ctx) => meter.prune(ctx, { before: Date.now() }))).rejects.toThrow(
    "PRUNE_TOO_RECENT",
  );

  expect(
    await t.run((ctx) => meter.prune(ctx, { before: Date.now() - LIMITS.pruneMinAgeMs })),
  ).toEqual({ deleted: 0, more: false });

  expect(await t.run((ctx) => meter.check(ctx, { subject: "owner", runId: "run" }))).toMatchObject({
    settledNanos: 100_000_000,
  });
});
