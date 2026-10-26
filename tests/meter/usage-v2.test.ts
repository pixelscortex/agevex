/** Fake provider evidence: live projections, same-charge reconciliation and bounds. */
import { componentsGeneric, internalMutationGeneric, type FunctionReference } from "convex/server";
import { v } from "convex/values";
import meterTest from "../../src/modules/meter/test.js";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { LIMITS, openRouterProvider, tokenEstimate } from "../../src/modules/meter/client/index.js";
import { setup, attribution, allBreakdowns } from "./setup.js";

// A safety margin only: the 59-node test takes ~2 s (it records and settles 59
// maximum-length nodes through the real path, then reads them in one query).
const TEST_LIMITS = { maxUsageNodesTimeoutMs: 30_000 };

const usage = { inputTokens: 3, outputTokens: 10 };
const estimate = tokenEstimate({ inputUsdPerMillion: 10, outputUsdPerMillion: 20 });

const viewArgs = {
  subject: attribution.subject,
  runId: attribution.runId,
  nodeIds: [null, "child"],
};

const drain = (t: ReturnType<typeof setup>["t"]) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("reconciliation updates one charge and replaces estimates without double-counting replay", async () => {
  const lookup = vi.fn(async () => ({ usd: 0.02 }));
  const { t, meter, component } = setup({ providers: { fake: { estimate, lookup } } });
  const scoped = { ...attribution, purpose: "agent" as const, nodeId: "child" };

  const record = async (ctx: Parameters<typeof meter.scope>[0]) => {
    await meter.scope(ctx, scoped).record("fake", { key: "step", usage, requestId: "generation" });
  };

  await t.run(record);
  const before = await t.query(component.charges.get, { key: "step" });

  expect(before).toMatchObject({
    source: "estimate",
    nanos: 230_000,
    reconciliation: "pending",
    providerRequestId: "generation",
  });

  expect((await t.run((ctx) => meter.usageView(ctx, viewArgs))).total).toMatchObject({
    inputTokens: 3,
    outputTokens: 10,
    estimatedUsd: 0.00023,
    settledUsd: 0,
  });

  await t.run((ctx) => meter.reconcile(ctx, viewArgs));
  await drain(t);
  await t.run(record);
  await t.run((ctx) => meter.reconcile(ctx, viewArgs));
  await drain(t);
  expect(lookup).toHaveBeenCalledTimes(1);

  expect(await t.query(component.charges.get, { key: "step" })).toMatchObject({
    _id: before!._id,
    source: "lookup",
    nanos: 20_000_000,
    reconciliation: "complete",
    revision: 1,
  });

  const view = await t.run((ctx) => meter.usageView(ctx, viewArgs));

  expect(view.total).toMatchObject({
    inputTokens: 3,
    outputTokens: 10,
    estimatedUsd: 0,
    settledUsd: 0.02,
    unknown: 0,
  });

  expect(view.nodes[0].usage.settledUsd).toBe(0);
  expect(view.nodes[1].usage.settledUsd).toBe(0.02);

  expect(
    await t.run((ctx) =>
      meter.subjectCost(ctx, { subject: attribution.subject, runId: attribution.runId }),
    ),
  ).toMatchObject({ totalNanos: 20_000_000 });
});

it.each(["missing", "failed"])(
  "a %s lookup keeps the estimate and retries evidence without any model call",
  async (kind) => {
    let ready = false;

    const lookup = vi.fn(async () => {
      if (ready) return { usd: 0.03 };

      if (kind === "failed") throw new Error("unavailable");

      return undefined;
    });

    const { t, meter, component } = setup({ providers: { fake: { estimate, lookup } } });

    await t.run(async (ctx) => {
      await meter
        .scope(ctx, attribution)
        .record("fake", { key: "retry", usage, requestId: "generation" });
    });

    await t.run((ctx) => meter.reconcile(ctx, viewArgs));

    await expect
      .poll(async () => {
        await t.finishInProgressScheduledFunctions();
        await vi.advanceTimersByTimeAsync(100);

        return lookup.mock.calls.length;
      })
      .toBe(1);

    const row = await t.query(component.charges.get, { key: "retry" });

    expect(row).toMatchObject({ nanos: 230_000, source: "estimate", reconciliation: "running" });
    ready = true;
    await drain(t);

    expect(await t.query(component.charges.get, { key: "retry" })).toMatchObject({
      _id: row!._id,
      source: "lookup",
      nanos: 30_000_000,
    });

    expect(lookup).toHaveBeenCalledTimes(2);
  },
);

it("missing tokens stay unknown and an attached request can recover missing inline evidence", async () => {
  const { t, meter, component } = setup({
    providers: { fake: { lookup: async () => ({ usd: 0 }) } },
  });

  await t.run(async (ctx) => {
    await meter.scope(ctx, attribution).record("fake", { key: "unknown", requestId: "generation" });
  });

  expect((await t.run((ctx) => meter.usageView(ctx, viewArgs))).total).toMatchObject({
    inputTokens: null,
    outputTokens: null,
    unknown: 1,
    reporting: "partial",
  });

  await t.run((ctx) => meter.reconcile(ctx, viewArgs));
  await drain(t);

  expect(await t.query(component.charges.get, { key: "unknown" })).toMatchObject({
    status: "settled",
    source: "lookup",
    nanos: 0,
  });

  expect((await t.run((ctx) => meter.usageView(ctx, viewArgs))).total).toMatchObject({
    inputTokens: null,
    settledUsd: 0,
    unknown: 0,
  });
});

it("the run sweep includes early child and tool charges and terminates after bounded batches", async () => {
  const lookup = vi.fn(async () => ({ usd: 0.01 }));
  const { t, meter } = setup({ providers: { fake: { estimate, lookup } } });
  const count = LIMITS.reconcileBatch * 2 + 1;

  for (let index = 0; index < count; index++)
    await t.run(async (ctx) => {
      await meter
        .scope(ctx, { ...attribution, purpose: index ? "tool" : "agent", nodeId: "child" })
        .record("fake", { key: `charge-${index}`, usage, requestId: `generation-${index}` });
    });

  await t.run((ctx) => meter.reconcile(ctx, viewArgs));
  await drain(t);
  expect(lookup).toHaveBeenCalledTimes(count);

  expect((await t.run((ctx) => meter.usageView(ctx, viewArgs))).nodes[1].usage).toMatchObject({
    settledUsd: count * 0.01,
    inputTokens: count * 3,
  });

  await t.run((ctx) => meter.reconcile(ctx, viewArgs));
  await drain(t);
  expect(lookup).toHaveBeenCalledTimes(count);
});

it("usage views isolate owned runs and enforce host authorization", async () => {
  const { t, meter } = setup({
    providers: { fake: { estimate } },
    authorize: async (_ctx, facts) => {
      if (facts.subject !== attribution.subject) throw new Error("FORBIDDEN");
    },
  });

  await t.run(async (ctx) => {
    await meter.scope(ctx, attribution).record("fake", { key: "owned", usage });
  });

  expect(
    (await t.run((ctx) => meter.usageView(ctx, { ...viewArgs, runId: "other" }))).total,
  ).toMatchObject({ inputTokens: null, estimatedUsd: 0 });

  await expect(
    t.run((ctx) => meter.usageView(ctx, { ...viewArgs, subject: "foreign" })),
  ).rejects.toThrow("FORBIDDEN");
});

it(
  "59 maximum-length usage nodes and all projections remain within enforced transaction budgets",
  async () => {
    const { t, meter } = setup({ breakdowns: allBreakdowns, providers: { fake: { estimate } } });

    const nodeIds = Array.from({ length: LIMITS.maxUsageNodes }, (_, index) =>
      `${index}`.padEnd(LIMITS.maxStringBytes, "n"),
    );

    for (const nodeId of nodeIds)
      await t.run(async (ctx) => {
        const charge = await meter
          .scope(ctx, { ...attribution, nodeId, purpose: "agent" })
          .record("fake", {
            key: nodeId,
            usage: { inputTokens: LIMITS.maxTokens, outputTokens: LIMITS.maxTokens },
          });

        await charge.settle({ usd: 0.01, key: "settle" });
      });

    const view = await t.run((ctx) => meter.usageView(ctx, { ...viewArgs, nodeIds }));

    expect(view.nodes).toHaveLength(LIMITS.maxUsageNodes);

    expect(view.total).toMatchObject({
      inputTokens: LIMITS.maxUsageNodes * LIMITS.maxTokens,
      settledUsd: LIMITS.maxUsageNodes * 0.01,
    });

    await expect(
      t.run((ctx) => meter.usageView(ctx, { ...viewArgs, nodeIds: [...nodeIds, "extra"] })),
    ).rejects.toThrow("INVALID_USAGE_NODES");
  },
  TEST_LIMITS.maxUsageNodesTimeoutMs,
);

it.each([0, 0.015, undefined, -1, "0.1"])(
  "OpenRouter generation lookup accepts only matching finite nonnegative cost (%s)",
  async (cost) => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ data: { id: "gen", total_cost: cost } })),
    );

    const provider = openRouterProvider({ apiKey: () => "fake-key", fetch: fetcher });
    const { t } = setup();
    const result = await t.action((ctx) => provider.lookup!(ctx, "gen"));

    expect(result ?? null).toEqual(typeof cost === "number" && cost >= 0 ? { usd: cost } : null);
    expect(fetcher.mock.calls).toHaveLength(1);
  },
);

it("OpenRouter lookup rejects foreign ids and bounds streamed response bytes", async () => {
  const { t } = setup();

  const foreign = openRouterProvider({
    apiKey: "fake",
    fetch: async () => new Response(JSON.stringify({ data: { id: "other", total_cost: 1 } })),
  });

  expect(await t.action(async (ctx) => (await foreign.lookup!(ctx, "gen")) ?? null)).toBeNull();
  let cancelled = false;

  const large = openRouterProvider({
    apiKey: "fake",
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(LIMITS.maxResponseBytes));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });

  await expect(t.action((ctx) => large.lookup!(ctx, "gen"))).rejects.toThrow(
    "METER_LOOKUP_RESPONSE_TOO_LARGE",
  );

  expect(cancelled).toBe(true);
});

it("inline zero remains authoritative and does not schedule an unnecessary provider lookup", async () => {
  const lookup = vi.fn(async () => ({ usd: 1 }));

  const { t, meter, component } = setup({
    providers: { fake: { inline: () => ({ usd: 0 }), estimate, lookup } },
  });

  await t.run(async (ctx) => {
    await meter.scope(ctx, { ...attribution, purpose: "agent" }).record("fake", {
      key: "free",
      usage: { inputTokens: 0, outputTokens: 0 },
      requestId: "generation",
    });
  });

  await t.run((ctx) =>
    meter.reconcile(ctx, { subject: attribution.subject, runId: attribution.runId }),
  );

  await drain(t);
  expect(lookup).not.toHaveBeenCalled();

  expect(await t.query(component.charges.get, { key: "free" })).toMatchObject({
    source: "inline",
    nanos: 0,
    providerRequestId: "generation",
    reconciliation: "complete",
  });

  expect((await t.run((ctx) => meter.usageView(ctx, viewArgs))).total).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
    reporting: "available",
  });
});

it("an unavailable request id retains its estimate and can attach later without creating a charge", async () => {
  const lookup = vi.fn(async () => ({ usd: 0.01 }));
  const { t, meter, component } = setup({ providers: { fake: { estimate, lookup } } });

  await t.run(async (ctx) => {
    await meter.scope(ctx, attribution).record("fake", { key: "late-id", usage });
  });

  const row = await t.query(component.charges.get, { key: "late-id" });

  expect(row).toMatchObject({ reconciliation: "unavailable", nanos: 230_000 });

  await t.run(async (ctx) => {
    const charge = await meter.scope(ctx, attribution).record("fake", { key: "late-id", usage });

    await charge.attach({ requestId: "generation", key: "attach" });
  });

  await drain(t);
  expect(lookup).toHaveBeenCalledTimes(1);

  expect(await t.query(component.charges.get, { key: "late-id" })).toMatchObject({
    _id: row!._id,
    nanos: 10_000_000,
    source: "lookup",
  });
});

it("charges without reconciliation metadata remain readable with an unavailable default", async () => {
  const { t, meter, component } = setup({ providers: { fake: { estimate } } });

  t.registerComponent("meter", meterTest.schema, {
    ...meterTest.modules,
    "./component/fixture.ts": async () => ({
      clear: internalMutationGeneric({
        args: { key: v.string() },
        returns: v.null(),
        handler: async (ctx, { key }) => {
          const row = await ctx.db
            .query("charges")
            .withIndex("by_key", (q) => q.eq("key", key))
            .unique();

          await ctx.db.patch(row!._id, { reconciliation: undefined });

          return null;
        },
      }),
    }),
  });

  await t.run(async (ctx) => {
    await meter.scope(ctx, attribution).record("fake", { key: "optional", usage });
  });

  await t.mutation(
    componentsGeneric().meter.fixture.clear as unknown as FunctionReference<"mutation">,
    { key: "optional" },
  );

  expect(await t.query(component.charges.get, { key: "optional" })).toMatchObject({
    reconciliation: "unavailable",
    status: "estimate",
  });

  expect((await t.run((ctx) => meter.usageView(ctx, viewArgs))).total).toMatchObject({
    inputTokens: 3,
    estimatedUsd: 0.00023,
  });
});
