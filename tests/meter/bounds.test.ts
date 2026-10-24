import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { mutationGeneric, type FunctionReference } from "convex/server";
import { v, type GenericId, type Value } from "convex/values";
import aggregate from "@convex-dev/aggregate/test";
import { LIMITS, type SinkEvent } from "../../src/meter/index.js";
import { setup } from "./setup.js";

const TEST_LIMITS = { seedBatch: 256, timeoutMs: 60_000, days: LIMITS.maxDays };
type Item = { k: Value; v: string; s: number };
type Node = { items: Item[]; children: number[]; aggregate: { count: number; sum: number } };

/**
 * Bulk fixture, NOT a second meter implementation: construct the upstream
 * B-tree's documented minimum/maximum occupancy to reach 100k entries without
 * performing 100k unrelated admissions. This exercises the real Aggregate
 * queries and split/merge mutations under convex-test transactionLimits.
 * Source: aggregate src/component/schema.ts:8-14,86-94; btree.ts:216-225.
 * Every fixture write batch is <=256*2 KiB (<512 KiB), <=256 docs.
 */
async function seedAtCapacity(t: ReturnType<typeof setup>["t"], subject: string, day: number) {
  const total = LIMITS.maxCharges - 1;
  const items: Item[] = Array.from({ length: total }, (_, index) => {
    const ordinal = day - TEST_LIMITS.days + 1 + (index % TEST_LIMITS.days);
    const id = `fixture-${String(index).padStart(6, "0")}`;
    return { k: [["", subject, "", ordinal, ""], id, ""], v: id, s: LIMITS.maxChargeNanos };
  });
  // Convex tuple ordering here is day then id (all subjects are identical).
  items.sort((a, b) => {
    const ak = a.k as [Value[], string, string];
    const bk = b.k as [Value[], string, string];
    return Number(ak[0][3]) - Number(bk[0][3]) || ak[1].localeCompare(bk[1]);
  });
  const nodes: Node[] = [];
  let offset = 0;
  function build(size: number, height: number, root = false): number {
    if (height === 1) {
      const entries = items.slice(offset, offset + size);
      offset += size;
      nodes.push({
        items: entries,
        children: [],
        aggregate: { count: size, sum: size * LIMITS.maxChargeNanos },
      });
      return nodes.length - 1;
    }
    const min = 3 ** (height - 1) - 1;
    const max = 5 ** (height - 1) - 1;
    let count = root ? 2 : 3;
    while (count <= 5 && (size - count + 1 < count * min || size - count + 1 > count * max))
      count++;
    if (count > 5) throw new Error("INVALID_FIXTURE_OCCUPANCY");
    const childSize = Math.floor((size - count + 1) / count);
    const extra = (size - count + 1) % count;
    const entries: Item[] = [];
    const children: number[] = [];
    for (let index = 0; index < count; index++) {
      children.push(build(childSize + (index < extra ? 1 : 0), height - 1));
      if (index < count - 1) entries.push(items[offset++]);
    }
    nodes.push({
      items: entries,
      children,
      aggregate: { count: size, sum: size * LIMITS.maxChargeNanos },
    });
    return nodes.length - 1;
  }
  const root = build(total, Math.ceil(Math.log(total + 1) / Math.log(5)), true);
  t.registerComponent("meter/costBySubject", aggregate.schema, {
    ...aggregate.modules,
    "./component/meterSeed.ts": async () => ({
      nodes: mutationGeneric({
        args: {
          nodes: v.array(
            v.object({
              items: v.array(v.object({ k: v.any(), v: v.string(), s: v.number() })),
              children: v.array(v.union(v.string(), v.number())),
              aggregate: v.object({ count: v.number(), sum: v.number() }),
            }),
          ),
        },
        handler: async (ctx, args) => {
          const ids: string[] = [];
          for (const node of args.nodes)
            ids.push(
              await ctx.db.insert("btreeNode", {
                items: node.items,
                aggregate: node.aggregate,
                subtrees: node.children.map((child) =>
                  typeof child === "number" ? ids[child] : child,
                ),
              }),
            );
          return ids;
        },
      }),
      root: mutationGeneric({
        args: { root: v.string() },
        handler: async (ctx, args) => {
          await ctx.db.insert("btree", {
            root: args.root as GenericId<"btreeNode">,
            namespace: ["cost", "settled"],
            maxNodeSize: LIMITS.aggregateNodeSize,
          });
        },
      }),
    }),
  });
  function reference<A extends Record<string, Value>>(name: string) {
    // convex-test documents this function-handle address format; it enters the
    // nested fixture component directly, without exposing any production API.
    return `function://meter/costBySubject;meterSeed:${name}` as unknown as FunctionReference<
      "mutation",
      "internal",
      A
    >;
  }
  const ids: string[] = [];
  for (let start = 0; start < nodes.length; start += TEST_LIMITS.seedBatch) {
    const batch = nodes.slice(start, start + TEST_LIMITS.seedBatch).map((node) => ({
      ...node,
      children: node.children.map((child) => (child < start ? ids[child] : child - start)),
    }));
    const saved = (await t.mutation(reference<{ nodes: typeof batch }>("nodes"), {
      nodes: batch,
    })) as string[];
    ids.push(...saved);
  }
  await t.mutation(reference<{ root: string }>("root"), { root: ids[root] });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it(
  "maximum mount capacity, payloads, sink fanout and seven-day reads fit enforced transaction budgets",
  async () => {
    const label = "é".repeat(LIMITS.maxStringBytes / 2);
    const key = "é".repeat(LIMITS.maxKeyBytes / 2);
    const events: SinkEvent[] = [];
    const { t, meter } = setup({
      providers: {
        [label]: {
          profiles: {
            [label]: {
              unit: label,
              usd: LIMITS.maxChargeNanos / LIMITS.nanosPerUsd / LIMITS.maxQuantity,
            },
          },
        },
      },
      sinks: Array.from({ length: LIMITS.maxSinks }, (_, index) => ({
        name: `${index}${"x".repeat(LIMITS.maxStringBytes - 1)}`,
        deliver: async (batch) => {
          events.push(...batch);
        },
      })),
    });
    const attribution = {
      subject: label,
      rootThreadId: label,
      threadId: label,
      runId: label,
      agent: label,
      model: label,
    };
    const day = Math.floor(Date.now() / LIMITS.dayMs);
    await seedAtCapacity(t, label, day);
    await t.run(async (ctx) => {
      await meter
        .scope(ctx, attribution)
        .estimate(label, { key, profile: label, quantity: LIMITS.maxQuantity });
    });
    const maxTotal = LIMITS.maxCharges * LIMITS.maxChargeNanos;
    expect(await t.run((ctx) => meter.subjectCost(ctx, { subject: label }))).toMatchObject({
      totalNanos: maxTotal,
    });
    // At full capacity existing charges must still settle, including migration
    // into the maximally populated namespace and the maximum sink fanout.
    await t.run(async (ctx) => {
      const charge = await meter
        .scope(ctx, attribution)
        .estimate(label, { key, profile: label, quantity: LIMITS.maxQuantity });
      await charge.settle({ usd: LIMITS.maxChargeNanos / LIMITS.nanosPerUsd });
    });
    const days = await t.run((ctx) =>
      meter.breakdown(ctx, {
        subject: label,
        from: (day - LIMITS.maxDays + 1) * LIMITS.dayMs,
        to: (day + 1) * LIMITS.dayMs,
        by: "day",
      }),
    );
    expect(days.page).toHaveLength(LIMITS.maxDays);
    expect(days.page.reduce((sum, item) => sum + item.settledNanos, 0)).toBe(maxTotal);
    await expect(
      t.run(async (ctx) => {
        await meter
          .scope(ctx, attribution)
          .estimate(label, { key: "capacity-overflow", profile: label, quantity: 1 });
      }),
    ).rejects.toThrow("METER_CAPACITY");
    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);
    expect(events).toHaveLength(LIMITS.maxSinks);
  },
  TEST_LIMITS.timeoutMs,
);
