/** Host-owned AI SDK 7 telemetry, with trusted attribution and isolated failures.
 * AI SDK's telemetry.ts defines callbacks and execution wrappers; agevex owns
 * neither spans nor exporters. Core turn/slots.ts owns the final flush deadline.
 */
import type { Telemetry } from "ai";
import type { SlotFacts, TelemetrySlot } from "../../../client/slots.js";
export type TelemetryFacts = Readonly<SlotFacts & {
    turnKey: string;
}>;
export type TelemetryOptions = {
    /** A factory can bind facts to an exporter's own metadata/span context. */
    integration: Telemetry | ((facts: TelemetryFacts) => Telemetry);
    flush?: (facts: TelemetryFacts, signal?: AbortSignal) => void | PromiseLike<void>;
};
/** Adapt a host integration without keeping buffers or credentials in agevex.
 * Fact snapshots are frozen and overwrite event.agevex, so model/tool content
 * cannot impersonate the run owner. Exporters must explicitly consume these
 * facts (or the factory argument); the SDK has no generic metadata option.
 */
export declare function telemetry({ integration, flush }: TelemetryOptions): TelemetrySlot;
