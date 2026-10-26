/**
 * Host entry point for action-scoped telemetry and reusable registration slots.
 * Public exports stay here; turn construction, SDK callbacks and bounded export
 * live in concept modules. This optional library owns no component or tables.
 */
import type { TelemetrySlot } from "../../../client/slots.js";
import { createTurnTelemetry } from "./turn.js";
import { validateOptions } from "./attribution.js";
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
export function telemetry(options: TelemetryOptions): TurnTelemetry {
  return createTurnTelemetry(options);
}

/**
 * Registration adapter. Configuration can be shared; mutable span buffers cannot.
 * Core supplies an opaque, stable turnKey and always flushes that key in finally.
 * Removing its entry before awaiting export prevents a hung exporter from keeping
 * a turn in the shared registry or contaminating later/concurrent turns. A retry
 * after flush gets a fresh buffer with stable ids and may export duplicates.
 */
telemetry.slot = (options: TelemetryOptions): TelemetrySlot => {
  validateOptions(options);
  const configuration = { ...options, exporters: [...options.exporters] };
  const turns = new Map<string, TurnTelemetry>();

  return {
    integration(facts) {
      const existing = turns.get(facts.turnKey);
      const turn = existing ?? createTurnTelemetry(configuration, false);
      // Validate/copy facts before admitting a new entry, so invalid attribution
      // cannot leave an unflushable buffer behind. Each integration's call paths
      // still come from the same per-turn ordinal allocator.
      const integration = turn.integration(facts);

      if (!existing) turns.set(facts.turnKey, turn);

      return integration;
    },
    async flush(facts, signal) {
      const turn = turns.get(facts.turnKey);

      turns.delete(facts.turnKey);

      try {
        // Missing, empty and already-flushed keys are no-ops. The one-shot buffer
        // seals synchronously, even if signal was already aborted. Core owns the
        // 3 s deadline; only race its signal here, without another timer/retry.
        // A direct host call without a signal gets the module's own deadline
        // instead (decided per flush in the turn buffer, see bestEffort's caller).
        await turn?.flush(signal);
      } catch {
        /* No telemetry export failure may change managed execution. */
      }
    },
  };
};
