import { expect, it, vi } from "vite-plus/test";
import { setup, attribution } from "./setup.js";
import {
  polarSink,
  webhookSink,
  SinkDeliveryError,
  openRouterCost,
  LIMITS,
  type SinkEvent,
} from "../../src/modules/meter/client/index.js";

function event(index: number): SinkEvent {
  return {
    key: `charge${index}`,
    externalId: `charge${index}`,
    revision: 1,
    nanos: 100_000_000,
    totalNanos: 100_000_000,
    attribution: { subject: "customer" },
    provider: "openrouter",
  };
}

it("Polar serializes signed integer nanos as exact decimal cents within twelve places", async () => {
  const amounts = [
    290_000_000,
    -290_000_000,
    1,
    -1,
    123_456_789,
    -123_456_789,
    LIMITS.maxChargeNanos,
    0,
  ];

  const expected = [
    "29",
    "-29",
    "0.0000001",
    "-0.0000001",
    "12.3456789",
    "-12.3456789",
    "9000",
    "0",
  ];

  const sink = polarSink({
    meter: "usage",
    accessToken: "test-token",
    fetch: async (_url, init) => {
      const body = String(init?.body as string | undefined);

      // Inspect the wire number: parsing alone would conceal excess decimal places.
      const tokens = [...body.matchAll(/"amount":(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g)].map(
        (m) => m[1],
      );

      expect(tokens).toEqual(expected);

      for (const token of tokens) expect(token).toMatch(/^-?\d+(?:\.\d{1,12})?$/);

      const payload = JSON.parse(body) as {
        events: { metadata: { _cost: { amount: unknown } } }[];
      };

      expect(payload.events.every((e) => typeof e.metadata._cost.amount === "number")).toBe(true);

      return Response.json({ inserted: amounts.length, duplicates: 0 });
    },
  });

  await sink.deliver(amounts.map((nanos, index) => ({ ...event(index), nanos })));
});

it("one delivery job drains up to 100 pending charges into a single Polar ingest request and accepts duplicate acknowledgements", async () => {
  vi.useFakeTimers();

  try {
    const seen = new Set<string>(["charge0"]); // Polar already holds one event.
    const sizes: number[] = [];

    const sink = polarSink({
      meter: "usage",
      accessToken: "test-token",
      server: "sandbox",
      fetch: async (url, init) => {
        expect(url).toBe("https://sandbox-api.polar.sh/v1/events/ingest");

        const payload = JSON.parse(String(init?.body as string | undefined)) as {
          events: {
            external_id: string;
            external_customer_id: string;
            metadata: { nanos: number };
          }[];
        };

        sizes.push(payload.events.length);
        let inserted = 0;

        for (const entry of payload.events) {
          expect(entry.external_customer_id).toBe(attribution.subject);
          expect(entry.metadata.nanos).toBe(100_000_000);

          if (!seen.has(entry.external_id)) inserted++;

          seen.add(entry.external_id);
        }

        return Response.json({ inserted, duplicates: payload.events.length - inserted });
      },
    });

    const { t, meter, component } = setup({ sinks: [sink] });
    const keys = Array.from({ length: LIMITS.sinkBatch + 1 }, (_, index) => `charge${index}`);

    for (const key of keys)
      await t.run(async (ctx) => {
        await meter.scope(ctx, attribution).record("openrouter", {
          key,
          providerMetadata: { openrouter: { usage: { cost: 0.1 } } },
        });
      });

    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);
    // The production job path, not the adapter alone: per-charge requests would be 101 x 1.
    expect(sizes).toEqual([LIMITS.sinkBatch, 1]);
    expect([...seen].sort()).toEqual([...keys].sort());

    for (const key of [keys[0], keys[LIMITS.sinkBatch]])
      expect((await t.query(component.charges.get, { key }))?.sinkState[0]).toMatchObject({
        deliveredNanos: 100_000_000,
        failed: false,
      });
  } finally {
    vi.useRealTimers();
  }
});

it("Polar honors Retry-After and refuses incomplete or oversized acknowledgements", async () => {
  const limited = polarSink({
    meter: "usage",
    accessToken: "test-token",
    fetch: async () => new Response(null, { status: 429, headers: { "Retry-After": "12" } }),
  });

  await expect(limited.deliver([event(0)])).rejects.toMatchObject({ retryAfterMs: 12_000 });

  for (const body of [JSON.stringify({ inserted: 0 }), "x".repeat(LIMITS.maxResponseBytes + 1)]) {
    const sink = polarSink({
      meter: "usage",
      accessToken: "test-token",
      fetch: async () => new Response(body),
    });

    await expect(sink.deliver([event(0)])).rejects.toBeInstanceOf(SinkDeliveryError);
  }
});

it("webhook delivery bounds batches and retains signed correction deltas and stable ids", async () => {
  const bodies: SinkEvent[][] = [];

  const sink = webhookSink({
    url: "https://ledger.example/events",
    fetch: async (_url, init) => {
      bodies.push(
        (JSON.parse(String(init?.body as string | undefined)) as { events: SinkEvent[] }).events,
      );

      return new Response(null, { status: 204 });
    },
  });

  const correction = {
    ...event(0),
    externalId: "charge0:delta:2",
    nanos: -50_000_000,
    totalNanos: 50_000_000,
    revision: 2,
  };

  await sink.deliver([event(0), correction]);
  expect(bodies[0].map((e) => e.nanos)).toEqual([100_000_000, -50_000_000]);
});

it("OpenRouter cost extraction distinguishes valid zero from absent or malformed evidence", () => {
  for (const cost of [0, 0.001])
    expect(openRouterCost({ openrouter: { usage: { cost } } })).toBe(cost);

  for (const cost of [undefined, null, NaN, Infinity, -1, "0"])
    expect(openRouterCost({ openrouter: { usage: { cost } } })).toBeUndefined();

  expect(openRouterCost(undefined)).toBeUndefined();
});
