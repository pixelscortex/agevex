import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { mutationGeneric, type FunctionReference } from "convex/server";
import { v, compareValues, type GenericId, type Value } from "convex/values";
import aggregate from "@convex-dev/aggregate/test";
import { LIMITS, type SinkEvent } from "../../src/modules/meter/client/index.js";
import { setup, allBreakdowns } from "./setup.js";

const TEST_LIMITS = { seedBatch: 256, timeoutMs: 180_000, days: LIMITS.maxDays, idBytes: 64 };

type Item = { k: Value; v: string; s: number };
type Node = { items: Item[]; children: number[]; aggregate?: { count: number; sum: number } };

/**
 * Bulk fixture, NOT a second meter implementation: construct the upstream
 * B-tree's documented minimum/maximum occupancy to reach 100k entries without
 * performing 100k unrelated admissions. This exercises the real Aggregate
 * queries and split/merge mutations under convex-test transactionLimits.
 * Source: aggregate src/component/schema.ts:8-14,86-94; btree.ts:216-225.
 * Every fixture write batch is <=256*2 KiB (<512 KiB), <=256 docs.
 */
async function seedProjection(
  t: ReturnType<typeof setup>["t"],
  mount: string,
  namespace: string[],
  items: Item[],
  register: boolean,
  value: number = LIMITS.maxChargeNanos,
) {
  const total = items.length;

  items.sort((a, b) => compareValues(a.k, b.k));
  const nodes: Node[] = [];
  let offset = 0;

  function build(size: number, height: number, root = false): number {
    if (height === 1) {
      const entries = items.slice(offset, offset + size);

      offset += size;

      nodes.push({
        items: entries,
        children: [],
        aggregate: { count: size, sum: size * value },
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

    // Roots stay lazy (the aggregate default the meter keeps): no root total.
    nodes.push({
      items: entries,
      children,
      ...(root ? {} : { aggregate: { count: size, sum: size * value } }),
    });

    return nodes.length - 1;
  }
  const root = build(total, Math.ceil(Math.log(total + 1) / Math.log(5)), true);

  if (register)
    t.registerComponent(mount, aggregate.schema, {
      ...aggregate.modules,
      "./component/meterSeed.ts": async () => ({
        nodes: mutationGeneric({
          args: {
            nodes: v.array(
              v.object({
                items: v.array(v.object({ k: v.any(), v: v.string(), s: v.number() })),
                children: v.array(v.union(v.string(), v.number())),
                aggregate: v.optional(v.object({ count: v.number(), sum: v.number() })),
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
          args: { root: v.string(), namespace: v.array(v.string()) },
          handler: async (ctx, args) => {
            await ctx.db.insert("btree", {
              root: args.root as GenericId<"btreeNode">,
              namespace: args.namespace,
              maxNodeSize: LIMITS.aggregateNodeSize,
            });
          },
        }),
      }),
    });

  function reference<A extends Record<string, Value>>(name: string) {
    // convex-test documents this function-handle address format; it enters the
    // nested fixture component directly, without exposing any production API.
    return `function://${mount};meterSeed:${name}` as unknown as FunctionReference<
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

  await t.mutation(reference<{ root: string; namespace: string[] }>("root"), {
    root: ids[root],
    namespace,
  });
}

/** All eight projections contain the same 99,999 charges (one below the
 * per-root-thread cap), split over every status, five maximum-byte axis labels
 * and seven days. This catches missing projection fixtures: thread/run/axis
 * totals must equal the subject total. Every namespace is owned by the one
 * subject/root thread under test; nothing is deployment-wide.
 * Fixture IDs exceed real system-generated charge ids (not caller-controlled).
 * Each seed batch is <=256*2 KiB (<512 KiB), <=256 document writes.
 */
async function seedAtCapacity(t: ReturnType<typeof setup>["t"], subject: string, day: number) {
  const states = ["estimate", "settled", "unknown"] as const;

  const labels = Array.from(
    { length: LIMITS.maxGroups + 1 },
    (_, i) => String(i) + "é".repeat((LIMITS.maxStringBytes - 2) / 2) + "x",
  );

  const projections = [
    {
      mount: "costByThread",
      namespace: ["thread", subject],
      key: (label: string, ordinal: number): Value[] => [label, ordinal],
    },
    {
      mount: "costBySubject",
      namespace: ["subject", subject],
      key: (_label: string, ordinal: number): Value[] => ["", ordinal],
    },
    {
      mount: "costBySubject",
      namespace: ["run", subject, subject],
      key: (_label: string, ordinal: number): Value[] => ["", ordinal],
    },
    {
      mount: "costBySubject",
      namespace: ["usage", subject, subject, "node", ""],
      key: (): Value[] => ["", 0],
    },
    ...["agent", "model", "provider"].map((axis) => ({
      mount: "costBySubject",
      namespace: ["axis", subject, axis],
      key: (label: string, ordinal: number): Value[] => [label, ordinal],
    })),
    ...["model", "provider"].map((axis) => ({
      mount: "costBySubject",
      namespace: ["thread", subject, axis],
      key: (label: string, ordinal: number): Value[] => [label, ordinal],
    })),
  ];

  const registered = new Set<string>();

  for (const projection of projections) {
    for (const [stateIndex, state] of states.entries()) {
      const items: Item[] = [];

      for (let index = stateIndex; index < LIMITS.maxThreadCharges - 1; index += states.length) {
        const ordinal = day - TEST_LIMITS.days + 1 + (index % TEST_LIMITS.days);
        const id = String(index).padStart(TEST_LIMITS.idBytes, "x");
        const key = projection.key(labels[index % labels.length], ordinal);
        const exploded = key.flatMap((part) => ["", part]).concat([""]);

        items.push({ k: [exploded, id, ""], v: id, s: LIMITS.maxChargeNanos });
      }

      await seedProjection(
        t,
        `meter/${projection.mount}`,
        [...projection.namespace, state],
        items,
        !registered.has(projection.mount),
      );

      registered.add(projection.mount);
    }
  }

  // Token namespaces hold all steps independent of settlement group. Populate
  // their lazy roots at the charge ceiling too, so the usage query cannot hide
  // a per-step scan behind an otherwise tiny 59-node fixture.
  for (const suffix of [[], ["node", ""]])
    for (const metric of ["inputTokens", "outputTokens"]) {
      const items: Item[] = Array.from({ length: LIMITS.maxThreadCharges - 1 }, (_, index) => {
        const id = String(index).padStart(TEST_LIMITS.idBytes, "x");

        return { k: [["", "", "", 0, ""], id, ""], v: id, s: LIMITS.maxTokens };
      });

      await seedProjection(
        t,
        "meter/costBySubject",
        ["usage", subject, subject, ...suffix, "tokens", metric],
        items,
        false,
        LIMITS.maxTokens,
      );
    }

  return labels;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
});

afterEach(() => vi.useRealTimers());

it(
  "maximum charge trees support thirteen projections and 59-node usage reads within enforced budgets",
  async () => {
    const label = "é".repeat(LIMITS.maxStringBytes / 2);
    const key = "é".repeat(LIMITS.maxKeyBytes / 2);
    const events: SinkEvent[] = [];

    const { t, meter } = setup({
      breakdowns: allBreakdowns,
      limits: { pruneMinAgeMs: 1 },
      providers: {
        [label]: {
          estimate: () => ({ usd: LIMITS.maxChargeNanos / LIMITS.nanosPerUsd }),
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
    const labels = await seedAtCapacity(t, label, day);

    await t.run(async (ctx) => {
      await meter
        .scope(ctx, attribution)
        .estimate(label, { key, profile: label, quantity: LIMITS.maxQuantity });
    });

    const knownFixtures = ((LIMITS.maxThreadCharges - 1) / 3) * 2;
    const maxTotal = (knownFixtures + 1) * LIMITS.maxChargeNanos;

    expect(await t.run((ctx) => meter.subjectCost(ctx, { subject: label }))).toMatchObject({
      totalNanos: maxTotal,
    });

    expect(await t.run((ctx) => meter.threadCost(ctx, { threadId: label }))).toMatchObject({
      totalNanos: maxTotal,
      unknown: (LIMITS.maxThreadCharges - 1) / 3,
      byAgent: {
        page: labels.slice(0, LIMITS.maxGroups).map((key) => ({ key })),
        cursor: labels[LIMITS.maxGroups - 1],
      },
    });

    expect(
      await t.run((ctx) => meter.subjectCost(ctx, { subject: label, runId: label })),
    ).toMatchObject({ totalNanos: maxTotal });

    // At full capacity existing charges must still settle, including migration
    // into the maximally populated namespace and the maximum sink fanout.
    await t.run(async (ctx) => {
      const charge = await meter
        .scope(ctx, attribution)
        .estimate(label, { key, profile: label, quantity: LIMITS.maxQuantity });

      await charge.attach({ requestId: label, key: "é".repeat(LIMITS.maxKeyBytes / 2) });

      await charge.correct({
        quantity: LIMITS.maxQuantity - 1,
        key: "lower-quantity".padEnd(LIMITS.maxKeyBytes, "x"),
      });

      await charge.correct({
        quantity: LIMITS.maxQuantity,
        key: "restore-quantity".padEnd(LIMITS.maxKeyBytes, "x"),
      });

      // Fill the receipt ledger before the final eight-projection replacement,
      // so transactionLimits covers maximum charge bytes and aggregate fanout together.
      for (let index = 0; index < LIMITS.maxOperations - 4; index++)
        await charge.correct({
          quantity: LIMITS.maxQuantity,
          key: String(index).padEnd(LIMITS.maxKeyBytes, "x"),
        });

      await charge.settle({
        usd: LIMITS.maxChargeNanos / LIMITS.nanosPerUsd,
        key: "settle".padEnd(LIMITS.maxKeyBytes, "x"),
      });
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
    expect(days.page.reduce((sum, item) => sum + item.totalNanos, 0)).toBe(maxTotal);

    for (const by of ["agent", "model", "provider"] as const) {
      const range = {
        subject: label,
        from: (day - LIMITS.maxDays + 1) * LIMITS.dayMs,
        to: (day + 1) * LIMITS.dayMs,
        by,
      };

      const first = await t.run((ctx) => meter.breakdown(ctx, range));

      expect(first.page).toHaveLength(LIMITS.maxGroups);
      expect(first.page.map((entry) => entry.key)).toEqual(labels.slice(0, LIMITS.maxGroups));
      expect(first.cursor).toBe(labels[LIMITS.maxGroups - 1]);
      const next = await t.run((ctx) => meter.breakdown(ctx, { ...range, cursor: first.cursor! }));

      expect([...first.page, ...next.page].reduce((sum, item) => sum + item.totalNanos, 0)).toBe(
        maxTotal,
      );

      expect(next.cursor).toBeNull();
    }

    const first = await t.run((ctx) => meter.threadCost(ctx, { threadId: label }));

    const next = await t.run((ctx) =>
      meter.threadCost(ctx, {
        threadId: label,
        cursors: {
          agent: first.byAgent.cursor!,
          model: first.byModel!.cursor!,
          provider: first.byProvider!.cursor!,
        },
      }),
    );

    for (const axis of ["byAgent", "byModel", "byProvider"] as const) {
      expect(first[axis]!.page).toHaveLength(LIMITS.maxGroups);
      expect(first[axis]!.cursor).toBe(labels[LIMITS.maxGroups - 1]);

      expect(
        [...first[axis]!.page, ...next[axis]!.page].reduce((sum, item) => sum + item.totalNanos, 0),
      ).toBe(maxTotal);

      expect(next[axis]!.cursor).toBeNull();
    }

    // The thread is now full: a new charge is recorded unknown, never thrown.
    await t.run(async (ctx) => {
      await meter
        .scope(ctx, attribution)
        .estimate(label, { key: "capacity-overflow", profile: label, quantity: 1 });
    });

    expect(await t.run((ctx) => meter.check(ctx, { subject: label, runId: label }))).toMatchObject({
      allowed: false,
    });

    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);
    expect(events).toHaveLength(LIMITS.maxSinks * 2);

    expect(events.reduce((sum, event) => sum + event.nanos, 0)).toBe(
      LIMITS.maxSinks * LIMITS.maxChargeNanos,
    );

    // Retention of the settled, delivered maximum charge fits one transaction
    // with all eight projections in maximally populated trees.
    expect(
      await t.run((ctx) =>
        meter.prune(ctx, { before: Date.now() - 1, limit: LIMITS.maxPruneLimit }),
      ),
    ).toEqual({ deleted: 1, more: false });

    expect(await t.run((ctx) => meter.subjectCost(ctx, { subject: label }))).toMatchObject({
      totalNanos: maxTotal - LIMITS.maxChargeNanos,
    });

    await t.run(async (ctx) => {
      const charge = await meter.scope(ctx, { ...attribution, purpose: "agent" }).record(label, {
        key: "tokens-at-capacity",
        usage: { inputTokens: LIMITS.maxTokens, outputTokens: LIMITS.maxTokens },
      });

      await charge.settle({ usd: 0.01, key: "provider-cost" });
    });

    const result = await t.run(async (ctx) => {
      const view = await meter.usageView(ctx, {
        subject: label,
        runId: label,
        nodeIds: [
          null,
          ...Array.from({ length: LIMITS.maxUsageNodes - 1 }, (_, index) =>
            String(index).padEnd(LIMITS.maxStringBytes, "n"),
          ),
        ],
      });

      return { view, bytes: (await ctx.meta.getTransactionMetrics()).bytesRead.used };
    });

    expect(result.bytes).toBeLessThan(8 << 20);
    expect(result.view.nodes).toHaveLength(LIMITS.maxUsageNodes);
    expect(result.view.total.inputTokens).toBe(LIMITS.maxThreadCharges * LIMITS.maxTokens);
    expect(result.view.nodes[0].usage.inputTokens).toBe(result.view.total.inputTokens);
  },
  TEST_LIMITS.timeoutMs,
);
