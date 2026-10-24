import { expect, it, vi } from "vite-plus/test";
import {
  polarSink,
  webhookSink,
  SinkDeliveryError,
  openRouterCost,
  LIMITS,
  type SinkEvent,
} from "../../src/meter/index.js";

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

it("Polar sends at most 100 events per batch with charge keys as external ids and accepts duplicate acknowledgements", async () => {
  const seen = new Set<string>();
  const sizes: number[] = [];
  const fakeFetch = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe("https://sandbox-api.polar.sh/v1/events/ingest");
    const payload = JSON.parse(String(init?.body)) as {
      events: { external_id: string; external_customer_id: string; metadata: { nanos: number } }[];
    };
    sizes.push(payload.events.length);
    let inserted = 0;
    for (const entry of payload.events) {
      expect(entry.external_customer_id).toBe("customer");
      expect(entry.metadata.nanos).toBe(100_000_000);
      if (!seen.has(entry.external_id)) {
        inserted++;
        seen.add(entry.external_id);
      }
    }
    return Response.json({ inserted, duplicates: payload.events.length - inserted });
  });
  const sink = polarSink({
    meter: "usage",
    accessToken: "test-token",
    server: "sandbox",
    fetch: fakeFetch,
  });
  const batch = Array.from({ length: LIMITS.sinkBatch + 1 }, (_, index) => event(index));
  await sink.deliver([...batch, batch[0]]);
  await sink.deliver(batch);
  expect(sizes).toEqual([LIMITS.sinkBatch, 1, LIMITS.sinkBatch, 1]);
  expect(seen.size).toBe(LIMITS.sinkBatch + 1);
  expect([...seen]).toEqual(batch.map((e) => e.key));
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
      bodies.push((JSON.parse(String(init?.body)) as { events: SinkEvent[] }).events);
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
