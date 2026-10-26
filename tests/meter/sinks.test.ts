import { expect, it, vi } from "vite-plus/test";
import { setup, attribution } from "./setup.js";
import {
  polarSink,
  webhookSink,
  SinkDeliveryError,
  openRouterCost,
  LIMITS,
  type Sink,
  type SinkEvent,
} from "../../src/modules/meter/client/index.js";

/** Built-in adapters are network-only: they never touch the host context. */
const ctx = {} as Parameters<Sink["deliver"]>[1];

function event(index: number): SinkEvent {
  return {
    key: `charge${index}`,
    externalId: `charge${index}`,
    revision: 1,
    status: "settled",
    source: "inline",
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

  await sink.deliver(
    amounts.map((nanos, index) => ({ ...event(index), nanos })),
    ctx,
  );
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

  await expect(limited.deliver([event(0)], ctx)).rejects.toMatchObject({ retryAfterMs: 12_000 });

  for (const body of [JSON.stringify({ inserted: 0 }), "x".repeat(LIMITS.maxResponseBytes + 1)]) {
    const sink = polarSink({
      meter: "usage",
      accessToken: "test-token",
      fetch: async () => new Response(body),
    });

    await expect(sink.deliver([event(0)], ctx)).rejects.toBeInstanceOf(SinkDeliveryError);
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

  await sink.deliver([event(0), correction], ctx);
  expect(bodies[0].map((e) => e.nanos)).toEqual([100_000_000, -50_000_000]);
});

it.each([false, true])(
  "webhook sinks deliver initial estimates only with opt-in %s while polar bills only final amounts",
  async (estimates) => {
    vi.useFakeTimers();

    try {
      const costs: number[] = [];
      const events: SinkEvent[] = [];

      const { t, meter } = setup({
        sinks: [
          polarSink({
            // Polar bills what it ingests: it must never see an estimate, even
            // if a JS caller forces the option the type no longer accepts.
            ...({ estimates } as object),
            meter: "usage",
            accessToken: "test-token",
            fetch: async (_url, init) => {
              const body = JSON.parse(String(init?.body as string | undefined)) as {
                events: { metadata: { nanos: number } }[];
              };

              costs.push(...body.events.map((entry) => entry.metadata.nanos));

              return Response.json({ inserted: body.events.length, duplicates: 0 });
            },
          }),
          webhookSink({
            estimates,
            url: "https://sink.example/events",
            fetch: async (_url, init) => {
              const body = JSON.parse(String(init?.body as string | undefined)) as {
                events: SinkEvent[];
              };

              events.push(...body.events);

              return new Response(null, { status: 204 });
            },
          }),
        ],
      });

      const estimate = () =>
        t.run(async (ctx) => {
          await meter.scope(ctx, attribution).estimate("fal", {
            key: "built-in-estimate",
            profile: "image",
            quantity: 1,
          });
        });

      await estimate();
      await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);
      expect(costs).toEqual([]);
      expect(events.map((entry) => entry.status)).toEqual(estimates ? ["estimate"] : []);

      await t.run(async (ctx) => {
        const charge = await meter.scope(ctx, attribution).estimate("fal", {
          key: "built-in-estimate",
          profile: "image",
          quantity: 1,
        });

        await charge.settle({ usd: 0.25, key: "settle" });
      });

      await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 1000);
      // Only the final amount, and no $0 classification revision.
      expect(costs).toEqual([250_000_000]);

      expect(events.map((entry) => entry.status)).toEqual(
        estimates ? ["estimate", "settled"] : ["settled"],
      );
    } finally {
      vi.useRealTimers();
    }
  },
);

it("OpenRouter cost extraction distinguishes valid zero from absent or malformed evidence", () => {
  for (const cost of [0, 0.001])
    expect(openRouterCost({ openrouter: { usage: { cost } } })).toBe(cost);

  for (const cost of [undefined, null, NaN, Infinity, -1, "0"])
    expect(openRouterCost({ openrouter: { usage: { cost } } })).toBeUndefined();

  expect(openRouterCost(undefined)).toBeUndefined();
});

it("Polar resolves a lazy access token at delivery, not at construction, and sends it as the bearer", async () => {
  const getToken = vi.fn(async () => "lazy-token");
  const headers: unknown[] = [];

  const sink = polarSink({
    meter: "usage",
    accessToken: getToken,
    fetch: async (_url, init) => {
      headers.push(init?.headers);

      return Response.json({ inserted: 1, duplicates: 0 });
    },
  });

  expect(getToken).not.toHaveBeenCalled();
  await sink.deliver([event(0)], ctx);
  expect(getToken).toHaveBeenCalledTimes(1);
  expect(headers[0]).toMatchObject({ Authorization: "Bearer lazy-token" });

  // A synchronous getter and a plain string are equally accepted.
  for (const accessToken of [() => "sync-token", "sync-token"]) {
    await polarSink({
      meter: "usage",
      accessToken,
      fetch: async (_url, init) => {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer sync-token" });

        return Response.json({ inserted: 1, duplicates: 0 });
      },
    }).deliver([event(0)], ctx);
  }
});

it("Polar refuses an empty lazy token at delivery with POLAR_TOKEN_REQUIRED and sends nothing", async () => {
  const request = vi.fn(async () => Response.json({ inserted: 1, duplicates: 0 }));
  const sink = polarSink({ meter: "usage", accessToken: () => "", fetch: request });

  await expect(sink.deliver([event(0)], ctx)).rejects.toThrow("POLAR_TOKEN_REQUIRED");
  expect(request).not.toHaveBeenCalled();
  expect(() => polarSink({ meter: "usage", accessToken: "" })).toThrow("POLAR_TOKEN_REQUIRED");
});
