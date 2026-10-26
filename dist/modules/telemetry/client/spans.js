/**
 * Span admission, bounded attributes and completion bookkeeping.
 * SDK handlers call these helpers with explicit turn/integration contexts.
 * The span ceiling preserves ancestry and distinguishes dropped from unfinished children.
 */
import { LIMITS, truncate } from "./limits.js";
import { markTruncated, now } from "./otlp.js";
/** Admit a span only while unsealed and below the shared ceiling; ancestry is retained. */
export function add(context, name, path, operation, observation, parent, kind = 1) {
    if (context.turn.sealed)
        return;
    if (context.turn.buffer.length >= LIMITS.maxSpansPerTurn) {
        // Keep already-recorded ancestry; never emit an orphan for a dropped parent.
        if (context.turn.buffer[0])
            markTruncated(context.turn.buffer[0].attributes);
        return;
    }
    const attributes = [];
    for (const [key, value] of Object.entries(context.common))
        context.turn.write(attributes, key, value);
    context.turn.write(attributes, "gen_ai.operation.name", operation);
    context.turn.write(attributes, "langfuse.observation.type", observation);
    const span = {
        seed: context.seed,
        path,
        parent,
        name: truncate(name, LIMITS.maxNameBytes),
        kind,
        startTimeUnixNano: now(),
        attributes,
        status: { code: 1 },
    };
    context.turn.buffer.push(span);
    return span;
}
/** Mark a recorded span failed without retaining raw SDK diagnostics. */
export function fail(span, reason) {
    if (span && reason)
        span.status = { code: 2, message: reason };
}
/** End a span once; later failure attribution may still update its safe status. */
export function finish(span, reason) {
    if (!span)
        return;
    span.endTimeUnixNano ??= now();
    fail(span, reason);
}
/** Translate only known failed SDK finish reasons into safe diagnostics. */
export const finishFailure = (reason) => reason === "error"
    ? "Model call failed"
    : reason === "interrupted"
        ? "Model call interrupted"
        : undefined;
/** Record opt-in content through the turn's bounded sanitizing writer. */
export function content(turn, span, key, value, enabled) {
    if (span && enabled)
        turn.write(span.attributes, key, value);
}
/** Keep only finite non-negative integer token counts from SDK usage. */
export function usage(turn, span, value) {
    if (!span || !value || typeof value !== "object")
        return;
    for (const [field, key] of [
        ["inputTokens", "gen_ai.usage.input_tokens"],
        ["outputTokens", "gen_ai.usage.output_tokens"],
    ]) {
        const count = value[field];
        if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
            turn.write(span.attributes, key, count);
    }
}
/**
 * Wrap add() for a call's child span. A missing result means the span ceiling
 * dropped it (callbacks never run once sealed), so record that on the call and
 * mark its root: context.turn.buffer[0] is only the first call's root, which would tell a
 * reader nothing about this call's own tree.
 */
export function child(call, span) {
    if (!span) {
        call.truncated = true;
        markTruncated(call.root.attributes);
    }
    return span;
}
/** Open means created and not ended; a span dropped for the ceiling is not open. */
export const unfinished = (call, span) => span ? !span.endTimeUnixNano : !call?.truncated;
/** Close open children as incomplete; a ceiling-dropped child was never open. */
export function endCall(context, callId, reason) {
    const call = context.calls.get(callId);
    if (!call)
        return;
    // onEnd is not proof of successful completion: SDK streams can close
    // with partial output and no model-call-end event. Every open child must
    // be failed rather than silently promoted to OK by its parent's end.
    //
    // Exception: a step or chat that is absent only because the turn hit the
    // span ceiling was never open, so it cannot be unfinished. Without this, a
    // call whose root took one of the last slots (its step/chat dropped) that
    // otherwise succeeded would be exported as "Call incomplete".
    const incomplete = unfinished(call, call.step) || unfinished(call, call.chat) || call.tools.size > 0;
    const failure = reason ?? (incomplete ? "Call incomplete" : undefined);
    finish(call.root, failure);
    if (!call.step?.endTimeUnixNano)
        finish(call.step, failure);
    // A completed model call must not become an error because a later tool failed.
    if (!call.chat?.endTimeUnixNano)
        finish(call.chat, failure);
    for (const tool of call.tools.values())
        finish(tool, failure);
    context.calls.delete(callId);
}
