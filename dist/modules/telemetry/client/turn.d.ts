import type { TelemetryOptions, TurnTelemetry } from "./types.js";
/** Build the explicit turn context, then compose SDK integration and one-shot flush. */
export declare function createTurnTelemetry(options: TelemetryOptions, ownDeadline?: boolean): TurnTelemetry;
