/**
 * Host HTTP sink adapters for Polar cost events and generic webhooks.
 * Delivery workers provide bounded immutable batches with stable external ids.
 * Adapters enforce response and request bounds and surface retry hints; the
 * component outbox owns durable attempt state and recipients deduplicate ids.
 */
import type { ActionCtx, Sink, SinkEvent } from "./types.js";
import { LIMITS, integer, text } from "../shared/limits.js";
import { resolveCredential, type Credential } from "./credential.js";

/** Polar documents a decimal NUMBER in cents, at most 17 digits / 12 places:
 * https://polar.sh/docs/features/cost-insights/cost-events#cost-metadata-schema
 * Emit an unquoted JSON number from integer arithmetic. Float division then
 * multiplication turns 290m nanos into 28.999999999999996 and is rejected.
 * A nanodollar is exactly 0.0000001 cents, so seven places suffice, including
 * negative delivery deltas. Other JSON fields still use JSON.stringify.
 */
function polarAmount(nanos: number) {
  // Over-cap amounts are billed in full: <=2^53 nanos is 9.0e8 cents, far
  // inside Polar's 17 significant digits.
  integer(Math.abs(nanos), LIMITS.maxBilledNanos, "NANOS");
  const value = BigInt(nanos);
  const magnitude = value < 0n ? -value : value;
  const divisor = BigInt(LIMITS.nanosPerCent);

  const fraction = (magnitude % divisor)
    .toString()
    .padStart(LIMITS.centDecimalPlaces, "0")
    .replace(/0+$/, "");

  return `${value < 0n ? "-" : ""}${magnitude / divisor}${fraction ? `.${fraction}` : ""}`;
}

/** `rateLimited` marks an HTTP 429: with `retryAfterMs`, the delivery job
 * reschedules once at that delay without consuming an attempt. */
export class SinkDeliveryError extends Error {
  constructor(
    public readonly retryAfterMs?: number,
    public readonly rateLimited = false,
  ) {
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

/** Translate failed HTTP delivery into bounded retry hints without retaining response bodies. */
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
    response.status === 429,
  );
}

/** Reject conflicting duplicate ids and chunk each invocation to the sink request ceiling. */
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

/** Thin REST adapter: @convex-dev/polar 0.9 has no event-ingestion API. The
 * delivery job hands it <=100 events (LIMITS.sinkBatch), one ingest request.
 * `accessToken` may be a getter, called at delivery time and never at
 * construction, so hosts need not read env at module init. */
export function polarSink(options: {
  meter: string;
  accessToken: Credential;
  server?: "production" | "sandbox";
  name?: string;
  estimates?: boolean;
  fetch?: typeof fetch;
}) {
  text(options.meter, "POLAR_METER");

  // A literal is checked now; a getter is checked on the value it returns.
  if (typeof options.accessToken === "string" && !options.accessToken)
    throw new Error("POLAR_TOKEN_REQUIRED");

  const base =
    options.server === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";

  return {
    name: options.name ?? "polar",
    estimates: options.estimates,
    deliver: async (batch: SinkEvent[], _ctx?: ActionCtx) => {
      const accessToken = await resolveCredential(options.accessToken, "POLAR_TOKEN_REQUIRED");

      for (const entries of batches(batch)) {
        const response = await (options.fetch ?? fetch)(`${base}/v1/events/ingest`, {
          method: "POST",
          signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: `{"events":[${entries
            .map((entry) => {
              const envelope = JSON.stringify({
                name: options.meter,
                external_id: entry.externalId,
                external_customer_id: entry.attribution.subject,
              });

              const metadata = JSON.stringify({
                nanos: entry.nanos,
                total_nanos: entry.totalNanos,
                provider: entry.provider,
              });

              return `${envelope.slice(0, -1)},"metadata":${metadata.slice(0, -1)},"_cost":{"amount":${polarAmount(entry.nanos)},"currency":"usd"}}}`;
            })
            .join(",")}]}`,
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
  } satisfies Sink;
}

/** Build a webhook adapter for delivery workers; the recipient must deduplicate external ids. */
export function webhookSink(options: {
  url: string;
  name?: string;
  estimates?: boolean;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}) {
  const url = new URL(options.url);

  if (!["https:", "http:"].includes(url.protocol)) throw new Error("INVALID_WEBHOOK_URL");

  return {
    name: options.name ?? "webhook",
    estimates: options.estimates,
    deliver: async (batch: SinkEvent[], _ctx?: ActionCtx) => {
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
  } satisfies Sink;
}
