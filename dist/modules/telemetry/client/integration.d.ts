/**
 * Compose AI SDK telemetry callbacks around an integration-local call map.
 * Every callback checks the shared seal and swallows observer failures so
 * instrumentation cannot change model execution or tool effects.
 */
import type { Telemetry } from "ai";
import type { Facts, TurnContext } from "./types.js";
/** Validate attribution, then compose short guarded handlers with an explicit context. */
export declare function createIntegration(turn: TurnContext, facts: Facts): Telemetry;
