/**
 * Public telemetry contracts and private buffer contexts.
 * Turn state is shared by all integrations for one action; integration state
 * keeps SDK call ancestry separate. No context owns Convex rows or transactions.
 */
import type { Telemetry } from "ai";
import type { Enabled } from "./enabled.js";
import type { Exporter } from "./exporters.js";
import type { attributeWriter, Sanitize, Span } from "./otlp.js";

export type Facts = {
  subject: string;
  rootThreadId: string;
  threadId: string;
  runId: string;
  agent: string;
  turnKey: string;
};
export type TelemetryOptions = {
  /** Resolved once per turn buffer. When false nothing is recorded or exported. Default true. */
  enabled?: Enabled;
  exporters: readonly Exporter[];
  recordInputs?: boolean;
  recordOutputs?: boolean;
  sanitize?: Sanitize;
};
export type TurnTelemetry = {
  integration: (facts: Facts) => Telemetry;
  flush: (signal?: AbortSignal) => Promise<void>;
};
export type BufferedSpan = Omit<Span, "traceId" | "spanId" | "parentSpanId" | "endTimeUnixNano"> & {
  seed: string;
  path: string;
  parent?: BufferedSpan;
  endTimeUnixNano?: string;
};
export type Call = {
  root: BufferedSpan;
  step?: BufferedSpan;
  chat?: BufferedSpan;
  modelAttempt: number;
  toolOrdinal: number;
  tools: Map<string, BufferedSpan>;
  /**
   * A child span (step, chat or tool) was never created because the turn hit
   * LIMITS.maxSpansPerTurn. The call itself may be perfectly healthy, so a span
   * that is absent for this reason must not be read as "never finished".
   */
  truncated?: boolean;
};

export type TurnContext = {
  options: TelemetryOptions;
  exporters: Exporter[];
  recordInputs: boolean;
  recordOutputs: boolean;
  write: ReturnType<typeof attributeWriter>;
  ownDeadline: boolean;
  callOrdinal: number;
  buffer: BufferedSpan[];
  sealed: boolean;
  /** The turn's switch resolved to off: callbacks record nothing. */
  disabled: boolean;
  /** Present only while an async `enabled` getter was used: callbacks wait for it. */
  gate?: Promise<boolean>;
  flushing?: Promise<void>;
  pendingDigests: Map<string, Promise<string>>;
};
export type IntegrationContext = {
  turn: TurnContext;
  identity: Facts;
  exported: Facts;
  seed: string;
  calls: Map<string, Call>;
  common: Record<string, string>;
};
export type Event<K extends keyof Telemetry> = Parameters<NonNullable<Telemetry[K]>>[0];
