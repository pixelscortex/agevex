/**
 * Configuration validation and the privacy boundary for exported attribution.
 * Integrations validate every fact before scheduling oversized-fact digests.
 * Raw ids remain local seeds; host sanitization also applies to span names.
 */
import { validateEnabled } from "./enabled.js";
import { LIMITS, bytes, truncate, validateString } from "./limits.js";
import { hash } from "./otlp.js";
import type { Call, Facts, IntegrationContext, TelemetryOptions, TurnContext } from "./types.js";

/** Validate configuration before a turn or slot can retain any mutable state. */
export function validateOptions(options: TelemetryOptions): void {
  if (!Array.isArray(options.exporters) || options.exporters.length > LIMITS.maxExporters)
    throw new Error("Invalid telemetry exporters");

  for (const exporter of options.exporters)
    if (!exporter || typeof exporter.export !== "function")
      throw new Error("Invalid telemetry exporter");

  validateEnabled(options.enabled);

  for (const flag of [options.recordInputs, options.recordOutputs])
    if (flag !== undefined && typeof flag !== "boolean")
      throw new Error("Invalid telemetry recording option");

  if (options.sanitize !== undefined && typeof options.sanitize !== "function")
    throw new Error("Invalid telemetry sanitize");
}

/** Sanitize each name at callback time; rejected names never fall back to raw input. */
export function nameComponent(turn: TurnContext, input: string, key: string): string {
  try {
    // Names are exported outside the attribute list, so they need their own
    // privacy boundary. Use the matching attribute key for host redaction rules;
    // never fall back to raw input when sanitization omits or rejects a name.
    const bounded = truncate(input, LIMITS.maxNameBytes);
    const value = turn.options.sanitize ? turn.options.sanitize(bounded, key) : bounded;

    return typeof value === "string" && value.trim()
      ? truncate(value, LIMITS.maxNameBytes)
      : "redacted";
  } catch {
    return "redacted";
  }
}

/**
 * Queue a digest without exposing rejected promises if this turn is abandoned.
 * WebCrypto is async while integration() is synchronous: only the placeholder
 * passes through sanitization, and flush later replaces it if it was retained.
 * The raw value is never stored on a span; map growth makes placeholders unique.
 */
function digestLater(turn: TurnContext, value: string): string {
  const placeholder = `sha256:pending:${turn.pendingDigests.size}`;
  const digest = hash(value, LIMITS.factDigestHexLength).then((hex) => `sha256:${hex}`);

  // A turn may be abandoned before flush. Observe rejection here while keeping
  // the original rejecting promise, so flush still skips that export on failure.
  digest.catch(() => {});
  turn.pendingDigests.set(placeholder, digest);

  return placeholder;
}

/** Copy and validate attribution before creating this integration's independent call map. */
export function integrationContext(turn: TurnContext, facts: Facts): IntegrationContext {
  const identity = { ...facts };
  const keys = ["subject", "rootThreadId", "threadId", "runId", "agent", "turnKey"] as const;

  // Presence stays mandatory (an empty or non-string fact is a wiring bug), but
  // length no longer is: a long subject used to make this throw, which core
  // treats as "telemetry unavailable" and silently drops the whole turn's trace.
  // Validate every key before digesting any, so a rejected set leaves no state.
  for (const key of keys) validateString(identity[key], key, Number.MAX_SAFE_INTEGER);

  const seed = JSON.stringify([identity.runId, identity.turnKey]);
  // Attribution as exported. The seed above keeps the raw ids (it is only ever
  // hashed again, never exported), so trace ids stay stable across retries.
  const exported = { ...identity };

  for (const key of keys)
    if (bytes(identity[key]) > LIMITS.maxFactBytes)
      exported[key] = digestLater(turn, identity[key]);

  const calls = new Map<string, Call>();

  const common = {
    "langfuse.session.id": exported.rootThreadId,
    "langfuse.user.id": exported.subject,
    "langfuse.trace.name": exported.agent,
    "langfuse.trace.metadata.thread_id": exported.threadId,
    "langfuse.trace.metadata.run_id": exported.runId,
    "langfuse.trace.metadata.agent": exported.agent,
    "langfuse.trace.metadata.turn_key": exported.turnKey,
  };

  return { turn, identity, exported, seed, calls, common };
}
