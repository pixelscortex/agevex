/**
 * Agent call and step SDK callbacks for one integration.
 * Handlers preserve callback order and safe failure propagation through ancestry.
 * The integration adapter guards every handler against sealing and observer failures.
 */
import { nameComponent } from "./attribution.js";
import { add, child, content, endCall, fail, finish, finishFailure, unfinished, usage, } from "./spans.js";
/** Open supported SDK calls using the shared turn ordinal, then attach opt-in input. */
export function onStart(context, event) {
    if (event.operationId !== "ai.streamText" && event.operationId !== "ai.generateText")
        return;
    const root = add(context, `invoke_agent ${nameComponent(context.turn, context.identity.agent, "gen_ai.agent.name")}`, `call:${context.turn.callOrdinal++}`, "invoke_agent", "agent");
    if (!root)
        return;
    context.calls.set(event.callId, { root, modelAttempt: 0, toolOrdinal: 0, tools: new Map() });
    context.turn.write(root.attributes, "gen_ai.agent.name", context.exported.agent);
    if ("modelId" in event)
        context.turn.write(root.attributes, "gen_ai.request.model", event.modelId);
    if ("provider" in event)
        context.turn.write(root.attributes, "gen_ai.provider.name", event.provider);
    if ("messages" in event)
        content(context.turn, root, "gen_ai.input.messages", event.messages, context.turn.recordInputs && event.recordInputs !== false);
    if ("instructions" in event)
        content(context.turn, root, "gen_ai.system_instructions", event.instructions, context.turn.recordInputs && event.recordInputs !== false);
}
/** Reset per-step attempts and tool ordinals when SDK opens the next step. */
export function onStepStart(context, event) {
    const call = context.calls.get(event.callId);
    if (!call)
        return;
    call.chat = undefined;
    call.modelAttempt = 0;
    call.toolOrdinal = 0;
    call.step = child(call, add(context, `step ${nameComponent(context.turn, String(event.stepNumber), "gen_ai.step.number")}`, `${call.root.path}/step:${event.stepNumber}`, "agent_step", "span", call.root));
}
/** Close a step while distinguishing a ceiling-dropped chat from an incomplete stream. */
export function onStepEnd(context, event) {
    const call = context.calls.get(event.callId);
    const step = call?.step;
    // stream-text.ts:3099-3152 reports error chunks through step completion
    // and retains partial output without a terminal chunk. Only an actual
    // model-call-end confirms completion; an explicit 'other' finish reason
    // is valid when that callback did arrive.
    //
    // A chat that was dropped for the span ceiling was never recorded, so its
    // absence says nothing about the stream; do not report it as incomplete.
    const failure = finishFailure(event.finishReason) ??
        (unfinished(call, call?.chat) ? "Model stream incomplete" : call?.chat?.status.message);
    if (!call?.chat?.endTimeUnixNano)
        finish(call?.chat, failure);
    finish(step, failure);
    fail(call?.root, failure);
    usage(context.turn, step, event.usage);
}
/** Record final usage/output and close the call without promoting unfinished children to success. */
export function onEnd(context, event) {
    const call = context.calls.get(event.callId);
    if ("text" in event)
        usage(context.turn, call?.root, event.usage);
    if ("text" in event)
        content(context.turn, call?.root, "langfuse.observation.output", event.text, context.turn.recordOutputs && event.recordOutputs !== false);
    endCall(context, event.callId, "finishReason" in event ? finishFailure(event.finishReason) : undefined);
}
/** Close the aborted SDK call with a safe reason; never export the raw abort diagnostic. */
export function onAbort(context, event) {
    endCall(context, event.callId, "Call aborted");
}
/** Close only the identified failed call; arbitrary SDK error content remains private. */
export function onError(context, event) {
    // AI SDK types this as unknown but stream-text.ts:2000,3283 supplies
    // { callId, error }. Never record the arbitrary error (it can contain input).
    if (event && typeof event === "object" && "callId" in event && typeof event.callId === "string")
        endCall(context, event.callId, "Call failed");
}
