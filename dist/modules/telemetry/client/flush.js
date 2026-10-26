/**
 * Seal and serialize the action buffer, then export once with bounded deadlines.
 * Digest placeholders resolve only when host sanitization retained them.
 * Export and WebCrypto failures are observer-only; no work is persisted or retried.
 */
import { bestEffort } from "./exporters.js";
import { LIMITS } from "./limits.js";
import { hash, now, payload } from "./otlp.js";
/** Derive stable ids and report any still-open span as incomplete at flush time. */
async function serializeSpan(span) {
    const traceId = await hash(span.seed, LIMITS.traceIdHexLength);
    const spanId = await hash(JSON.stringify([span.seed, span.path]), LIMITS.spanIdHexLength);
    const parentSpanId = span.parent
        ? await hash(JSON.stringify([span.parent.seed, span.parent.path]), LIMITS.spanIdHexLength)
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
        status: span.endTimeUnixNano ? span.status : { code: 2, message: "Span incomplete at flush" },
    };
}
/** Export the detached snapshot once; unavailable WebCrypto must not change the agent result. */
async function exportSpans(turn, spans, signal) {
    try {
        if (!spans.length || signal?.aborted)
            return;
        // Resolve oversized-fact digests first. Only the exact placeholder this
        // turn minted is replaced, and only if sanitize left it untouched: a host
        // that redacted the attribute keeps its own redaction.
        if (turn.pendingDigests.size) {
            const digests = new Map(await Promise.all([...turn.pendingDigests].map(async ([placeholder, digest]) => [placeholder, await digest])));
            for (const span of spans)
                for (const attribute of span.attributes) {
                    const value = "stringValue" in attribute.value && attribute.value.stringValue;
                    const digest = value ? digests.get(value) : undefined;
                    if (digest)
                        attribute.value = { stringValue: digest };
                }
        }
        // No Convex reads/writes. At the hard ceiling: 128 spans × 16 KiB
        // encoded attributes = 2 MiB; names/ids/times/envelopes add < 256 KiB,
        // so the single OTLP request is < 2.25 MiB. At most four exporters
        // run concurrently; standalone buffers own a 3 s deadline, managed
        // buffers receive core's bounded signal. Neither path retries.
        const serialized = await Promise.all(spans.map(serializeSpan));
        const body = payload(serialized);
        await Promise.all(turn.exporters.map((exporter) => bestEffort((exportSignal) => exporter.export(body, exportSignal), signal, 
        // Managed turns normally lean on core's bounded signal, but a host
        // may call slot.flush(facts) directly with none. Without a signal
        // there is no deadline at all, so a hung exporter would hang the
        // caller forever: fall back to this module's own 3 s deadline.
        turn.ownDeadline || signal === undefined)));
    }
    catch {
        /* Even unavailable WebCrypto must not change the agent result. */
    }
}
/** Seal synchronously and detach the buffer before awaiting any digest or exporter. */
export function flushTurn(turn, signal) {
    if (turn.flushing)
        return turn.flushing;
    turn.sealed = true;
    const spans = turn.buffer;
    turn.buffer = [];
    turn.flushing = exportSpans(turn, spans, signal);
    return turn.flushing;
}
