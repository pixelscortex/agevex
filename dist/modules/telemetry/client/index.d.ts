/**
 * Host entry point for action-scoped telemetry and reusable registration slots.
 * Public exports stay here; turn construction, SDK callbacks and bounded export
 * live in concept modules. This optional library owns no component or tables.
 */
import type { TelemetrySlot } from "../../../client/slots.js";
import type { TelemetryOptions, TurnTelemetry } from "./types.js";
export { braintrust, langfuse, type Exporter } from "./exporters.js";
export type { Credential, Setting } from "./credential.js";
export type { Enabled } from "./enabled.js";
export { LIMITS } from "./limits.js";
export type { Attribute, AttributeValue, OtlpPayload, Sanitize, Span } from "./otlp.js";
export type { Facts, TelemetryOptions, TurnTelemetry } from "./types.js";
/**
 * Action-scoped, one-shot buffer. Create a fresh instance for each turn, attach its
 * integration to streamText, consume the stream, then await flush in finally.
 *
 * AI SDK 7's callback seam is ai/src/telemetry/telemetry.ts:136-360;
 * telemetry-options.ts:24-76 contains integrations and has no tracer option.
 * The observer-only failure guard follows the verified prior art in
 * agents/src/runtime/tracing.ts:133-215, without its durable outbox/SDK layer.
 */
export declare function telemetry(options: TelemetryOptions): TurnTelemetry;
export declare namespace telemetry {
    var slot: (options: TelemetryOptions) => TelemetrySlot;
}
