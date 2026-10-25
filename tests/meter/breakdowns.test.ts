import { DirectAggregate } from "@convex-dev/aggregate";
import type { ComponentApi as AggregateApi } from "@convex-dev/aggregate/_generated/component.js";
import { expect, it, vi } from "vite-plus/test";
import {
  BreakdownDisabledError,
  defineMeter,
  LIMITS,
  type Breakdown,
  type MeterOptions,
} from "../../src/modules/meter/client/index.js";
import { setup, attribution, allBreakdowns } from "./setup.js";

function aggregateCounts(mount: string) {
  // convex-test's documented function-handle format addresses nested mounts
  // directly; root componentsGeneric references resolve only one component hop.
  return new DirectAggregate<{ Key: [string, number | string]; Id: string; Namespace: string[] }>({
    btree: { aggregateBetween: `function://meter/${mount};btree:aggregateBetween` },
  } as unknown as AggregateApi);
}
const thread = aggregateCounts("costByThread");
const subject = aggregateCounts("costBySubject");

const optionalProjections = allBreakdowns.map((breakdown) => ({
  breakdown,
  namespace: breakdown.startsWith("thread.")
    ? ["thread", attribution.rootThreadId, breakdown.split(".")[1]]
    : ["axis", attribution.subject, breakdown.split(".")[1]],
}));

// Count aggregate contributions through the upstream public client, without
// depending on B-tree node layout or the meter's projection implementation.
async function counts(t: ReturnType<typeof setup>["t"]) {
  return await t.run(async (ctx) => {
    const projections = [
      { tree: thread, namespace: ["thread", attribution.rootThreadId] },
      { tree: subject, namespace: ["subject", attribution.subject] },
      { tree: subject, namespace: ["run", attribution.subject, attribution.runId] },
      ...optionalProjections.map(({ namespace }) => ({ tree: subject, namespace })),
    ];

    const counts = [];

    for (const { tree, namespace } of projections) {
      let count = 0;

      for (const state of ["estimate", "settled", "unknown"])
        count += await tree.count(ctx, { namespace: [...namespace, state] });

      counts.push(count);
    }

    return counts;
  });
}

it.each(["estimate", "record"] as const)(
  "default %s charges contribute only to thread, subject and run projections",
  async (method) => {
    const { t, meter } = setup();

    await t.run(async (ctx) => {
      const scoped = meter.scope(ctx, attribution);

      if (method === "estimate")
        await scoped.estimate("fal", { key: "default", profile: "image", quantity: 4 });
      else await scoped.record("openrouter", { key: "default" });
    });

    expect(await counts(t)).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
    const cost = await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }));

    expect(cost.byAgent.page).toHaveLength(1);
    expect(cost).not.toHaveProperty("byModel");
    expect(cost).not.toHaveProperty("byProvider");

    await t.run(async (ctx) => {
      const scoped = meter.scope(ctx, attribution);

      const charge =
        method === "estimate"
          ? await scoped.estimate("fal", { key: "default", profile: "image", quantity: 4 })
          : await scoped.record("openrouter", { key: "default" });

      if (method === "estimate") await charge.correct({ quantity: 2, key: "correct-2" });

      await charge.settle({ usd: 0.25, key: "settle-0.25" });
    });

    expect(await counts(t)).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);

    expect(
      await t.run((ctx) => meter.check(ctx, { subject: "owner", runId: "run" })),
    ).toMatchObject({
      allowed: true,
      settledNanos: 250_000_000,
    });

    const day = Math.floor(Date.now() / LIMITS.dayMs) * LIMITS.dayMs;

    const days = await t.run((ctx) =>
      meter.breakdown(ctx, { subject: "owner", from: day, to: day + LIMITS.dayMs, by: "day" }),
    );

    expect(days.page[0].settledNanos).toBe(250_000_000);
  },
);

it("disabled breakdown reads fail at the API boundary with a typed option error", async () => {
  const { t, meter } = setup();

  await t.run(async (ctx) => {
    const runQuery = vi.spyOn(ctx, "runQuery");

    for (const by of ["agent", "model", "provider"] as const) {
      const read = meter.breakdown(ctx, { subject: "owner", from: 0, to: LIMITS.dayMs, by });

      await expect(read).rejects.toBeInstanceOf(BreakdownDisabledError);

      await expect(read).rejects.toMatchObject({
        code: "BREAKDOWN_DISABLED",
        breakdown: `subject.${by}`,
        message: expect.stringContaining(`breakdowns: ["subject.${by}"]`),
      });
    }

    for (const axis of ["model", "provider"] as const) {
      const read = meter.threadCost(ctx, { threadId: "root", cursors: { [axis]: "" } });

      await expect(read).rejects.toBeInstanceOf(BreakdownDisabledError);

      await expect(read).rejects.toMatchObject({
        code: "BREAKDOWN_DISABLED",
        breakdown: `thread.${axis}`,
        message: expect.stringContaining(`breakdowns: ["thread.${axis}"]`),
      });
    }

    expect(runQuery).not.toHaveBeenCalled();
  });
});

it.each(allBreakdowns)("enabling %s writes only that optional projection", async (breakdown) => {
  const { t, meter } = setup({ breakdowns: [breakdown] });

  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).estimate("fal", {
      key: "enabled",
      profile: "image",
      quantity: 4,
    });

    await charge.correct({ quantity: 2, key: "correct-2" });
    await charge.settle({ usd: 0.25, key: "settle-0.25" });
  });

  expect(await counts(t)).toEqual([
    1,
    1,
    1,
    ...allBreakdowns.map((option) => Number(option === breakdown)),
  ]);

  const cost = await t.run((ctx) => meter.threadCost(ctx, { threadId: "root" }));

  expect("byModel" in cost).toBe(breakdown === "thread.model");
  expect("byProvider" in cost).toBe(breakdown === "thread.provider");

  if (breakdown.startsWith("subject.")) {
    const day = Math.floor(Date.now() / LIMITS.dayMs) * LIMITS.dayMs;

    const result = await t.run((ctx) =>
      meter.breakdown(ctx, {
        subject: "owner",
        from: day,
        to: day + LIMITS.dayMs,
        by: breakdown.split(".")[1] as "agent" | "model" | "provider",
      }),
    );

    expect(result.page).toMatchObject([{ settledNanos: 250_000_000 }]);
  }
});

it("later opt-ins cover new charges while replays and old-charge transitions preserve membership", async () => {
  const { t, meter, component } = setup();

  const enabled = defineMeter(component, {
    providers: { fal: { profiles: { image: { unit: "image", usd: 0.25 } } } },
    breakdowns: allBreakdowns,
  });

  await t.run(async (ctx) => {
    await meter
      .scope(ctx, attribution)
      .estimate("fal", { key: "before", profile: "image", quantity: 4 });

    const old = await enabled.scope(ctx, attribution).estimate("fal", {
      key: "before",
      profile: "image",
      quantity: 4,
    });

    await old.correct({ quantity: 2, key: "correct-2" });
    await old.settle({ usd: 0.25, key: "settle-0.25" });

    await enabled
      .scope(ctx, attribution)
      .estimate("fal", { key: "after", profile: "image", quantity: 4 });

    // Removing an opt-in from host configuration cannot strand contributions
    // already written for a charge, including those updated by async workers.
    const newer = await meter.scope(ctx, attribution).estimate("fal", {
      key: "after",
      profile: "image",
      quantity: 4,
    });

    await newer.settle({ usd: 0.5, key: "settle-0.5" });
  });

  expect(await counts(t)).toEqual([2, 2, 2, 1, 1, 1, 1, 1]);
  const cost = await t.run((ctx) => enabled.threadCost(ctx, { threadId: "root" }));

  expect(cost).toMatchObject({
    settledNanos: 750_000_000,
    byAgent: { page: [{ settledNanos: 750_000_000 }] },
    byModel: { page: [{ settledNanos: 500_000_000 }] },
    byProvider: { page: [{ settledNanos: 500_000_000 }] },
  });
});

it("registration rejects unknown breakdown options", () => {
  expect(() => setup({ breakdowns: ["thread.agent" as Breakdown] })).toThrow("INVALID_BREAKDOWNS");

  expect(() =>
    setup({ breakdowns: "thread.model" as unknown as MeterOptions["breakdowns"] }),
  ).toThrow("INVALID_BREAKDOWNS");
});
