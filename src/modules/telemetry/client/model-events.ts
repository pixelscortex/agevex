/**
 * Model attempt SDK callbacks for one integration.
 * Handlers preserve callback order and safe failure propagation through ancestry.
 * The integration adapter guards every handler against sealing and observer failures.
 */
import { nameComponent } from "./attribution.js";
import { add, child, content, fail, finish, finishFailure, usage } from "./spans.js";
import type { Event, IntegrationContext } from "./types.js";

/** Open the next model attempt beneath its step and record only permitted input. */
export function onLanguageModelCallStart(
  context: IntegrationContext,
  event: Event<"onLanguageModelCallStart">,
): void {
  const call = context.calls.get(event.callId);

  if (!call?.step) return;

  call.chat = child(
    call,
    add(
      context,
      `chat ${nameComponent(context.turn, event.modelId, "gen_ai.request.model")}`,
      `${call.step.path}/chat:${call.modelAttempt++}`,
      "chat",
      "generation",
      call.step,
      3,
    ),
  );

  if (!call.chat) return;

  context.turn.write(call.chat.attributes, "gen_ai.request.model", event.modelId);
  context.turn.write(call.chat.attributes, "gen_ai.provider.name", event.provider);

  content(
    context.turn,
    call.chat,
    "gen_ai.input.messages",
    event.messages,
    context.turn.recordInputs && event.recordInputs !== false,
  );

  content(
    context.turn,
    call.chat,
    "gen_ai.system_instructions",
    event.instructions,
    context.turn.recordInputs && event.recordInputs !== false,
  );
}

/** Close a completed model attempt and propagate safe failure status to its ancestors. */
export function onLanguageModelCallEnd(
  context: IntegrationContext,
  event: Event<"onLanguageModelCallEnd">,
): void {
  const call = context.calls.get(event.callId);
  const chat = call?.chat;

  if (!chat) return;

  // SDK 7 language-model-events.ts:42-73 supplies the finish reason even
  // for failures delivered as normal completion callbacks. Do not rely
  // on onError, which is absent for several streamed provider failures.
  const failure = finishFailure(event.finishReason);

  finish(chat, failure);
  fail(call?.step, failure);
  fail(call?.root, failure);
  usage(context.turn, chat, event.usage);
  context.turn.write(chat.attributes, "gen_ai.response.model", event.modelId);
  context.turn.write(chat.attributes, "gen_ai.response.id", event.responseId);
  context.turn.write(chat.attributes, "gen_ai.response.finish_reasons", [event.finishReason]);

  content(
    context.turn,
    chat,
    "gen_ai.output.messages",
    event.content,
    context.turn.recordOutputs && event.recordOutputs !== false,
  );
}
