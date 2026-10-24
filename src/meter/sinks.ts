import type { Sink, SinkEvent } from "./types.js";
import { LIMITS, text } from "./limits.js";

export class SinkDeliveryError extends Error {
  constructor(public readonly retryAfterMs?: number) {
    super("METER_SINK_DELIVERY_FAILED");
  }
}

/** Bounded response consumption also applies to third-party error bodies. */
async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SinkDeliveryError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LIMITS.maxResponseBytes) throw new SinkDeliveryError();
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function checkResponse(response: Response) {
  if (response.ok) return;
  await response.body?.cancel();
  const header = response.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  const delay = Number.isFinite(seconds)
    ? seconds * LIMITS.backoffMs
    : Date.parse(header ?? "") - Date.now();
  throw new SinkDeliveryError(
    Number.isFinite(delay)
      ? Math.min(LIMITS.maxLookupMs, Math.max(0, Math.ceil(delay)))
      : undefined,
  );
}

function batches(batch: SinkEvent[]) {
  // Deduplication here is a convenience, not a durable ledger. The recipient
  // MUST deduplicate externalId across retries and uncertain HTTP outcomes.
  const unique = new Map<string, SinkEvent>();
  for (const entry of batch) {
    const previous = unique.get(entry.externalId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
      throw new Error("SINK_KEY_CONFLICT");
    unique.set(entry.externalId, entry);
  }
  const entries = [...unique.values()];
  const output: SinkEvent[][] = [];
  for (let offset = 0; offset < entries.length; offset += LIMITS.sinkBatch)
    output.push(entries.slice(offset, offset + LIMITS.sinkBatch));
  return output;
}

/** Thin REST adapter: @convex-dev/polar 0.9 has no event-ingestion API. */
export function polarSink(options: {
  meter: string;
  accessToken: string;
  server?: "production" | "sandbox";
  name?: string;
  fetch?: typeof fetch;
}): Sink {
  text(options.meter, "POLAR_METER");
  if (!options.accessToken) throw new Error("POLAR_TOKEN_REQUIRED");
  const base =
    options.server === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";
  return {
    name: options.name ?? "polar",
    deliver: async (batch) => {
      for (const entries of batches(batch)) {
        const response = await (options.fetch ?? fetch)(`${base}/v1/events/ingest`, {
          method: "POST",
          signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
          headers: {
            Authorization: `Bearer ${options.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            events: entries.map((entry) => ({
              name: options.meter,
              external_id: entry.externalId,
              external_customer_id: entry.attribution.subject,
              metadata: {
                nanos: entry.nanos,
                total_nanos: entry.totalNanos,
                provider: entry.provider,
                _cost: {
                  amount: (entry.nanos / LIMITS.nanosPerUsd) * LIMITS.centsPerUsd,
                  currency: "usd",
                },
              },
            })),
          }),
        });
        await checkResponse(response);
        const result = (await readJson(response)) as { inserted?: number; duplicates?: number };
        if (
          !Number.isSafeInteger(result.inserted) ||
          (result.inserted ?? -1) < 0 ||
          !Number.isSafeInteger(result.duplicates ?? 0) ||
          (result.duplicates ?? 0) < 0 ||
          (result.inserted ?? 0) + (result.duplicates ?? 0) !== entries.length
        )
          throw new SinkDeliveryError();
      }
    },
  };
}

export function webhookSink(options: {
  url: string;
  name?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}): Sink {
  const url = new URL(options.url);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("INVALID_WEBHOOK_URL");
  return {
    name: options.name ?? "webhook",
    deliver: async (batch) => {
      for (const entries of batches(batch)) {
        const response = await (options.fetch ?? fetch)(options.url, {
          method: "POST",
          headers: { ...options.headers, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
          body: JSON.stringify({ events: entries }),
        });
        await checkResponse(response);
        await response.body?.cancel();
      }
    },
  };
}
