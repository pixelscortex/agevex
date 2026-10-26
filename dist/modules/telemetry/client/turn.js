/**
 * Construct one mutable, one-shot telemetry buffer per action.
 * All integrations share its ordinal allocator and span ceiling, while their
 * SDK call maps remain separate. Flushing seals the context before export starts.
 */
import { validateOptions } from "./attribution.js";
import { resolveEnabled } from "./enabled.js";
import { createIntegration } from "./integration.js";
import { flushTurn } from "./flush.js";
import { attributeWriter } from "./otlp.js";
/** Build the explicit turn context, then compose SDK integration and one-shot flush. */
export function createTurnTelemetry(options, ownDeadline = true) {
    validateOptions(options);
    const exporters = [...options.exporters];
    const recordInputs = options.recordInputs === true;
    const recordOutputs = options.recordOutputs === true;
    const write = attributeWriter(options.sanitize);
    // One resolution per buffer, here: a slot creates its buffer lazily at the
    // turn's first integration, so a getter never runs at construction/registration.
    const open = resolveEnabled(options.enabled);
    // Allocate from the shared turn buffer, not from each integration. The run/turn
    // seed namespaces traces; call order namespaces their span paths across every
    // integration, independently of random SDK call ids. Repeating that order in a
    // fresh buffer gives stable ids, but a retried action may export duplicates:
    // Langfuse v4 does not guarantee upserts for repeated ids. Core never retries
    // paid model steps automatically, so duplicates are rare. Hosts requiring
    // exactly-once export can export from their own durable outbox.
    const turn = {
        options,
        exporters,
        recordInputs,
        recordOutputs,
        write,
        ownDeadline,
        callOrdinal: 0,
        buffer: [],
        sealed: false,
        disabled: open === false,
        pendingDigests: new Map(),
    };
    // An async getter gates callbacks until it answers; they record nothing if off.
    if (typeof open !== "boolean")
        turn.gate = open.then((enabled) => {
            turn.disabled = !enabled;
            return enabled;
        });
    return {
        integration: (facts) => createIntegration(turn, facts),
        flush: (signal) => flushTurn(turn, signal),
    };
}
