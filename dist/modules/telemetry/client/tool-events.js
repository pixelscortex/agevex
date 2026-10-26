/**
 * Tool execution SDK callbacks for one integration.
 * Handlers preserve callback order and safe failure propagation through ancestry.
 * The integration adapter guards every handler against sealing and observer failures.
 */
import { nameComponent } from "./attribution.js";
import { add, child, content, finish } from "./spans.js";
/** Open a tool beneath its model/step using the step ordinal, preserving stable ancestry. */
export function onToolExecutionStart(context, event) {
    const call = context.calls.get(event.callId);
    if (!call?.step)
        return;
    const tool = child(call, add(context, `execute_tool ${nameComponent(context.turn, event.toolCall.toolName, "gen_ai.tool.name")}`, `${call.step.path}/tool:${call.toolOrdinal++}`, "execute_tool", "tool", call.chat ?? call.step));
    if (!tool)
        return;
    call.tools.set(event.toolCall.toolCallId, tool);
    context.turn.write(tool.attributes, "gen_ai.tool.name", event.toolCall.toolName);
    context.turn.write(tool.attributes, "gen_ai.tool.call.id", event.toolCall.toolCallId);
    content(context.turn, tool, "gen_ai.tool.call.arguments", event.toolCall.input, context.turn.recordInputs && event.recordInputs !== false);
}
/** Finish the matching tool and record only permitted successful output before forgetting it. */
export function onToolExecutionEnd(context, event) {
    const call = context.calls.get(event.callId);
    const tool = call?.tools.get(event.toolCall.toolCallId);
    if (!tool)
        return;
    finish(tool, event.toolOutput.type !== "tool-result" ? "Tool execution failed" : undefined);
    if (event.toolOutput.type === "tool-result")
        content(context.turn, tool, "gen_ai.tool.call.result", event.toolOutput.output, context.turn.recordOutputs && event.recordOutputs !== false);
    call?.tools.delete(event.toolCall.toolCallId);
}
