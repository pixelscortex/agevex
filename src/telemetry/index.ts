import type { Telemetry } from "ai";
import type { TelemetrySlot } from "../client/slots.js";
import { bestEffort, type Exporter } from "./exporters.js";
import { LIMITS, bytes, truncate, validateString } from "./limits.js";
import {
  attributeWriter,
  hash,
  markTruncated,
  now,
  payload,
  type Attribute,
  type Sanitize,
  type Span,
} from "./otlp.js";

export { braintrust, langfuse, type Exporter } from "./exporters.js";
export { LIMITS } from "./limits.js";
export type { Attribute, AttributeValue, OtlpPayload, Sanitize, Span } from "./otlp.js";

export type Facts = {
  subject: string;
  rootThreadId: string;
  threadId: string;
  runId: string;
  agent: string;
  turnKey: string;
};
export type TelemetryOptions = {
  exporters: readonly Exporter[];
  recordInputs?: boolean;
  recordOutputs?: boolean;
  sanitize?: Sanitize;
};
export type TurnTelemetry = {
  integration: (facts: Facts) => Telemetry;
  flush: (signal?: AbortSignal) => Promise<void>;
};
type BufferedSpan = Omit<Span, "traceId" | "spanId" | "parentSpanId" | "endTimeUnixNano"> & {
  seed: string;
  path: string;
  parent?: BufferedSpan;
  endTimeUnixNano?: string;
};
type Call = {
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

function validateOptions(options: TelemetryOptions): void {
  if (!Array.isArray(options.exporters) || options.exporters.length > LIMITS.maxExporters)
    throw new Error("Invalid telemetry exporters");

  for (const exporter of options.exporters)
    if (!exporter || typeof exporter.export !== "function")
      throw new Error("Invalid telemetry exporter");

  for (const flag of [options.recordInputs, options.recordOutputs])
    if (flag !== undefined && typeof flag !== "boolean")
      throw new Error("Invalid telemetry recording option");

  if (options.sanitize !== undefined && typeof options.sanitize !== "function")
    throw new Error("Invalid telemetry sanitize");
}

function createTurnTelemetry(options: TelemetryOptions, ownDeadline = true): TurnTelemetry {
  validateOptions(options);
  const exporters = [...options.exporters];
  const recordInputs = options.recordInputs === true;
  const recordOutputs = options.recordOutputs === true;
  const write = attributeWriter(options.sanitize);

  const nameComponent = (input: string, key: string): string => {
    try {
      // Names are exported outside the attribute list, so they need their own
      // privacy boundary. Use the matching attribute key for host redaction rules;
      // never fall back to raw input when sanitization omits or rejects a name.
      const bounded = truncate(input, LIMITS.maxNameBytes);
      const value = options.sanitize ? options.sanitize(bounded, key) : bounded;

      return typeof value === "string" && value.trim()
        ? truncate(value, LIMITS.maxNameBytes)
        : "redacted";
    } catch {
      return "redacted";
    }
  };

  // Allocate from the shared turn buffer, not from each integration. The run/turn
  // seed namespaces traces; call order namespaces their span paths across every
  // integration, independently of random SDK call ids. Repeating that order in a
  // fresh buffer gives stable ids, but a retried action may export duplicates:
  // Langfuse v4 does not guarantee upserts for repeated ids. Core never retries
  // paid model steps automatically, so duplicates are rare. Hosts requiring
  // exactly-once export can export from their own durable outbox.
  let callOrdinal = 0;
  let buffer: BufferedSpan[] = [];
  let sealed = false;
  let flushing: Promise<void> | undefined;
  // Oversized facts are exported as a SHA-256 digest, but WebCrypto is async while
  // integration() must return synchronously. The attribute is written with a short
  // placeholder now (still passing through the host's sanitize rules by key) and
  // swapped for the real digest at flush, before anything leaves the process. The
  // raw value is never stored on a span. Map size only grows, so ids are unique.
  const pendingDigests = new Map<string, Promise<string>>();

  const digestLater = (value: string): string => {
    const placeholder = `sha256:pending:${pendingDigests.size}`;
    const digest = hash(value, LIMITS.factDigestHexLength).then((hex) => `sha256:${hex}`);

    // flush may never run (the turn can be abandoned): observe a WebCrypto
    // rejection here so it cannot surface as an unhandled rejection. The original
    // promise still rejects when flush awaits it, which skips that export.
    digest.catch(() => {});
    pendingDigests.set(placeholder, digest);

    return placeholder;
  };

  return {
    integration(facts) {
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
        if (bytes(identity[key]) > LIMITS.maxFactBytes) exported[key] = digestLater(identity[key]);

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

      const add = (
        name: string,
        path: string,
        operation: string,
        observation: string,
        parent?: BufferedSpan,
        kind: Span["kind"] = 1,
      ): BufferedSpan | undefined => {
        if (sealed) return;

        if (buffer.length >= LIMITS.maxSpansPerTurn) {
          // Keep already-recorded ancestry; never emit an orphan for a dropped parent.
          if (buffer[0]) markTruncated(buffer[0].attributes);

          return;
        }

        const attributes: Attribute[] = [];

        for (const [key, value] of Object.entries(common)) write(attributes, key, value);

        write(attributes, "gen_ai.operation.name", operation);
        write(attributes, "langfuse.observation.type", observation);

        const span: BufferedSpan = {
          seed,
          path,
          parent,
          name: truncate(name, LIMITS.maxNameBytes),
          kind,
          startTimeUnixNano: now(),
          attributes,
          status: { code: 1 },
        };

        buffer.push(span);

        return span;
      };

      const fail = (span: BufferedSpan | undefined, reason?: string) => {
        if (span && reason) span.status = { code: 2, message: reason };
      };

      const finish = (span?: BufferedSpan, reason?: string) => {
        if (!span) return;

        span.endTimeUnixNano ??= now();
        fail(span, reason);
      };

      const finishFailure = (reason: string) =>
        reason === "error"
          ? "Model call failed"
          : reason === "interrupted"
            ? "Model call interrupted"
            : undefined;

      const content = (
        span: BufferedSpan | undefined,
        key: string,
        value: unknown,
        enabled: boolean,
      ) => {
        if (span && enabled) write(span.attributes, key, value);
      };

      const usage = (span: BufferedSpan | undefined, value: unknown) => {
        if (!span || !value || typeof value !== "object") return;

        for (const [field, key] of [
          ["inputTokens", "gen_ai.usage.input_tokens"],
          ["outputTokens", "gen_ai.usage.output_tokens"],
        ] as const) {
          const count = (value as Record<string, unknown>)[field];

          if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
            write(span.attributes, key, count);
        }
      };

      /**
       * Wrap add() for a call's child span. A missing result means the span ceiling
       * dropped it (callbacks never run once sealed), so record that on the call and
       * mark its root: buffer[0] is only the first call's root, which would tell a
       * reader nothing about this call's own tree.
       */
      const child = (call: Call, span: BufferedSpan | undefined) => {
        if (!span) {
          call.truncated = true;
          markTruncated(call.root.attributes);
        }

        return span;
      };

      /** Open means created and not ended; a span dropped for the ceiling is not open. */
      const unfinished = (call: Call | undefined, span: BufferedSpan | undefined) =>
        span ? !span.endTimeUnixNano : !call?.truncated;

      const endCall = (callId: string, reason?: string) => {
        const call = calls.get(callId);

        if (!call) return;

        // onEnd is not proof of successful completion: SDK streams can close
        // with partial output and no model-call-end event. Every open child must
        // be failed rather than silently promoted to OK by its parent's end.
        //
        // Exception: a step or chat that is absent only because the turn hit the
        // span ceiling was never open, so it cannot be unfinished. Without this, a
        // call whose root took one of the last slots (its step/chat dropped) that
        // otherwise succeeded would be exported as "Call incomplete".
        const incomplete =
          unfinished(call, call.step) || unfinished(call, call.chat) || call.tools.size > 0;

        const failure = reason ?? (incomplete ? "Call incomplete" : undefined);

        finish(call.root, failure);

        if (!call.step?.endTimeUnixNano) finish(call.step, failure);

        // A completed model call must not become an error because a later tool failed.
        if (!call.chat?.endTimeUnixNano) finish(call.chat, failure);

        for (const tool of call.tools.values()) finish(tool, failure);

        calls.delete(callId);
      };

      const safe =
        <E>(callback: (event: E) => void) =>
        (event: E) => {
          if (sealed) return;

          try {
            callback(event);
          } catch {
            /* Telemetry never changes paid execution. */
          }
        };

      const integration: Telemetry = {
        onStart: safe((event) => {
          if (event.operationId !== "ai.streamText" && event.operationId !== "ai.generateText")
            return;

          const root = add(
            `invoke_agent ${nameComponent(identity.agent, "gen_ai.agent.name")}`,
            `call:${callOrdinal++}`,
            "invoke_agent",
            "agent",
          );

          if (!root) return;

          calls.set(event.callId, { root, modelAttempt: 0, toolOrdinal: 0, tools: new Map() });
          write(root.attributes, "gen_ai.agent.name", exported.agent);

          if ("modelId" in event) write(root.attributes, "gen_ai.request.model", event.modelId);

          if ("provider" in event) write(root.attributes, "gen_ai.provider.name", event.provider);

          if ("messages" in event)
            content(
              root,
              "gen_ai.input.messages",
              event.messages,
              recordInputs && event.recordInputs !== false,
            );

          if ("instructions" in event)
            content(
              root,
              "gen_ai.system_instructions",
              event.instructions,
              recordInputs && event.recordInputs !== false,
            );
        }),
        onStepStart: safe((event) => {
          const call = calls.get(event.callId);

          if (!call) return;

          call.chat = undefined;
          call.modelAttempt = 0;
          call.toolOrdinal = 0;

          call.step = child(
            call,
            add(
              `step ${nameComponent(String(event.stepNumber), "gen_ai.step.number")}`,
              `${call.root.path}/step:${event.stepNumber}`,
              "agent_step",
              "span",
              call.root,
            ),
          );
        }),
        onLanguageModelCallStart: safe((event) => {
          const call = calls.get(event.callId);

          if (!call?.step) return;

          call.chat = child(
            call,
            add(
              `chat ${nameComponent(event.modelId, "gen_ai.request.model")}`,
              `${call.step.path}/chat:${call.modelAttempt++}`,
              "chat",
              "generation",
              call.step,
              3,
            ),
          );

          if (!call.chat) return;

          write(call.chat.attributes, "gen_ai.request.model", event.modelId);
          write(call.chat.attributes, "gen_ai.provider.name", event.provider);

          content(
            call.chat,
            "gen_ai.input.messages",
            event.messages,
            recordInputs && event.recordInputs !== false,
          );

          content(
            call.chat,
            "gen_ai.system_instructions",
            event.instructions,
            recordInputs && event.recordInputs !== false,
          );
        }),
        onLanguageModelCallEnd: safe((event) => {
          const call = calls.get(event.callId);
          const chat = call?.chat;

          if (!chat) return;

          // SDK 7 language-model-events.ts:42-73 supplies the finish reason even
          // for failures delivered as normal completion callbacks. Do not rely
          // on onError, which is absent for several streamed provider failures.
          const failure = finishFailure(event.finishReason);

          finish(chat, failure);
          fail(call?.step, failure);
          fail(call?.root, failure);
          usage(chat, event.usage);
          write(chat.attributes, "gen_ai.response.model", event.modelId);
          write(chat.attributes, "gen_ai.response.id", event.responseId);
          write(chat.attributes, "gen_ai.response.finish_reasons", [event.finishReason]);

          content(
            chat,
            "gen_ai.output.messages",
            event.content,
            recordOutputs && event.recordOutputs !== false,
          );
        }),
        onToolExecutionStart: safe((event) => {
          const call = calls.get(event.callId);

          if (!call?.step) return;

          const tool = child(
            call,
            add(
              `execute_tool ${nameComponent(event.toolCall.toolName, "gen_ai.tool.name")}`,
              `${call.step.path}/tool:${call.toolOrdinal++}`,
              "execute_tool",
              "tool",
              call.chat ?? call.step,
            ),
          );

          if (!tool) return;

          call.tools.set(event.toolCall.toolCallId, tool);
          write(tool.attributes, "gen_ai.tool.name", event.toolCall.toolName);
          write(tool.attributes, "gen_ai.tool.call.id", event.toolCall.toolCallId);

          content(
            tool,
            "gen_ai.tool.call.arguments",
            event.toolCall.input,
            recordInputs && event.recordInputs !== false,
          );
        }),
        onToolExecutionEnd: safe((event) => {
          const call = calls.get(event.callId);
          const tool = call?.tools.get(event.toolCall.toolCallId);

          if (!tool) return;

          finish(
            tool,
            event.toolOutput.type !== "tool-result" ? "Tool execution failed" : undefined,
          );

          if (event.toolOutput.type === "tool-result")
            content(
              tool,
              "gen_ai.tool.call.result",
              event.toolOutput.output,
              recordOutputs && event.recordOutputs !== false,
            );

          call?.tools.delete(event.toolCall.toolCallId);
        }),
        onStepEnd: safe((event) => {
          const call = calls.get(event.callId);
          const step = call?.step;

          // stream-text.ts:3099-3152 reports error chunks through step completion
          // and retains partial output without a terminal chunk. Only an actual
          // model-call-end confirms completion; an explicit 'other' finish reason
          // is valid when that callback did arrive.
          //
          // A chat that was dropped for the span ceiling was never recorded, so its
          // absence says nothing about the stream; do not report it as incomplete.
          const failure =
            finishFailure(event.finishReason) ??
            (unfinished(call, call?.chat) ? "Model stream incomplete" : call?.chat?.status.message);

          if (!call?.chat?.endTimeUnixNano) finish(call?.chat, failure);

          finish(step, failure);
          fail(call?.root, failure);
          usage(step, event.usage);
        }),
        onEnd: safe((event) => {
          const call = calls.get(event.callId);

          if ("text" in event) usage(call?.root, event.usage);

          if ("text" in event)
            content(
              call?.root,
              "langfuse.observation.output",
              event.text,
              recordOutputs && event.recordOutputs !== false,
            );

          endCall(
            event.callId,
            "finishReason" in event ? finishFailure(event.finishReason) : undefined,
          );
        }),
        onAbort: safe((event) => endCall(event.callId, "Call aborted")),
        onError: safe((event) => {
          // AI SDK types this as unknown but stream-text.ts:2000,3283 supplies
          // { callId, error }. Never record the arbitrary error (it can contain input).
          if (
            event &&
            typeof event === "object" &&
            "callId" in event &&
            typeof event.callId === "string"
          )
            endCall(event.callId, "Call failed");
        }),
      };

      return integration;
    },
    flush(signal) {
      if (flushing) return flushing;

      sealed = true;
      const spans = buffer;

      buffer = [];

      flushing = (async () => {
        try {
          if (!spans.length || signal?.aborted) return;

          // Resolve oversized-fact digests first. Only the exact placeholder this
          // turn minted is replaced, and only if sanitize left it untouched: a host
          // that redacted the attribute keeps its own redaction.
          if (pendingDigests.size) {
            const digests = new Map(
              await Promise.all(
                [...pendingDigests].map(
                  async ([placeholder, digest]) => [placeholder, await digest] as const,
                ),
              ),
            );

            for (const span of spans)
              for (const attribute of span.attributes) {
                const value = "stringValue" in attribute.value && attribute.value.stringValue;
                const digest = value ? digests.get(value) : undefined;

                if (digest) attribute.value = { stringValue: digest };
              }
          }

          // No Convex reads/writes. At the hard ceiling: 128 spans × 16 KiB
          // encoded attributes = 2 MiB; names/ids/times/envelopes add < 256 KiB,
          // so the single OTLP request is < 2.25 MiB. At most four exporters
          // run concurrently; standalone buffers own a 3 s deadline, managed
          // buffers receive core's bounded signal. Neither path retries.
          const serialized = await Promise.all(
            spans.map(async (span): Promise<Span> => {
              const traceId = await hash(span.seed, LIMITS.traceIdHexLength);

              const spanId = await hash(
                JSON.stringify([span.seed, span.path]),
                LIMITS.spanIdHexLength,
              );

              const parentSpanId = span.parent
                ? await hash(
                    JSON.stringify([span.parent.seed, span.parent.path]),
                    LIMITS.spanIdHexLength,
                  )
                : undefined;

              return {
                traceId,
                spanId,
                ...(parentSpanId ? { parentSpanId } : {}),
                name: span.name,
                kind: span.kind,
                startTimeUnixNano: span.startTimeUnixNano,
                endTimeUnixNano: span.endTimeUnixNano ?? now(),
                attributes: span.attributes,
                status: span.endTimeUnixNano
                  ? span.status
                  : { code: 2, message: "Span incomplete at flush" },
              };
            }),
          );

          const body = payload(serialized);

          await Promise.all(
            exporters.map((exporter) =>
              bestEffort(
                (exportSignal) => exporter.export(body, exportSignal),
                signal,
                // Managed turns normally lean on core's bounded signal, but a host
                // may call slot.flush(facts) directly with none. Without a signal
                // there is no deadline at all, so a hung exporter would hang the
                // caller forever: fall back to this module's own 3 s deadline.
                ownDeadline || signal === undefined,
              ),
            ),
          );
        } catch {
          /* Even unavailable WebCrypto must not change the agent result. */
        }
      })();

      return flushing;
    },
  };
}
