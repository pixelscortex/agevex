/**
 * Compose AI SDK telemetry callbacks around an integration-local call map.
 * Every callback checks the shared seal and swallows observer failures so
 * instrumentation cannot change model execution or tool effects.
 */
import type { Telemetry } from "ai";
import { integrationContext } from "./attribution.js";
import { onStart, onStepStart, onStepEnd, onEnd, onAbort, onError } from "./agent-events.js";
import { onLanguageModelCallStart, onLanguageModelCallEnd } from "./model-events.js";
import { onToolExecutionStart, onToolExecutionEnd } from "./tool-events.js";
import type { Facts, TurnContext } from "./types.js";

/** Ignore callbacks after flush and prevent arbitrary observer errors escaping into execution. */
function safe<E>(turn: TurnContext, callback: (event: E) => void) {
  return (event: E) => {
    if (turn.sealed) return;

    try {
      callback(event);
    } catch {
      /* Telemetry never changes paid execution. */
    }
  };
}

/** Validate attribution, then compose short guarded handlers with an explicit context. */
export function createIntegration(turn: TurnContext, facts: Facts): Telemetry {
  const context = integrationContext(turn, facts);

  return {
    onStart: safe(turn, (event) => onStart(context, event)),
    onStepStart: safe(turn, (event) => onStepStart(context, event)),
    onLanguageModelCallStart: safe(turn, (event) => onLanguageModelCallStart(context, event)),
    onLanguageModelCallEnd: safe(turn, (event) => onLanguageModelCallEnd(context, event)),
    onToolExecutionStart: safe(turn, (event) => onToolExecutionStart(context, event)),
    onToolExecutionEnd: safe(turn, (event) => onToolExecutionEnd(context, event)),
    onStepEnd: safe(turn, (event) => onStepEnd(context, event)),
    onEnd: safe(turn, (event) => onEnd(context, event)),
    onAbort: safe(turn, (event) => onAbort(context, event)),
    onError: safe(turn, (event) => onError(context, event)),
  };
}
