/**
 * Host HTTP sink adapters for Polar cost events and generic webhooks.
 * Delivery workers provide bounded immutable batches with stable external ids.
 * Adapters enforce response and request bounds and surface retry hints; the
 * component outbox owns durable attempt state and recipients deduplicate ids.
 */
import type { Sink } from "./types.js";
/** `rateLimited` marks an HTTP 429: with `retryAfterMs`, the delivery job
 * reschedules once at that delay without consuming an attempt. */
export declare class SinkDeliveryError extends Error {
    readonly retryAfterMs?: number | undefined;
    readonly rateLimited: boolean;
    constructor(retryAfterMs?: number | undefined, rateLimited?: boolean);
}
/** Thin REST adapter: @convex-dev/polar 0.9 has no event-ingestion API. The
 * delivery job hands it <=100 events (LIMITS.sinkBatch), one ingest request. */
export declare function polarSink(options: {
    meter: string;
    accessToken: string;
    server?: "production" | "sandbox";
    name?: string;
    fetch?: typeof fetch;
}): Sink;
/** Build a webhook adapter for delivery workers; the recipient must deduplicate external ids. */
export declare function webhookSink(options: {
    url: string;
    name?: string;
    headers?: Record<string, string>;
    fetch?: typeof fetch;
}): Sink;
