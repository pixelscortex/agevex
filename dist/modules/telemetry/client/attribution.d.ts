import type { Facts, IntegrationContext, TelemetryOptions, TurnContext } from "./types.js";
/** Validate configuration before a turn or slot can retain any mutable state. */
export declare function validateOptions(options: TelemetryOptions): void;
/** Sanitize each name at callback time; rejected names never fall back to raw input. */
export declare function nameComponent(turn: TurnContext, input: string, key: string): string;
/** Copy and validate attribution before creating this integration's independent call map. */
export declare function integrationContext(turn: TurnContext, facts: Facts): IntegrationContext;
