import type { ToolSet } from "ai";
import type { RuntimeContext } from "../registration/context.js";
import type { SlotFacts } from "../slots.js";
import type { HookContext, Registration } from "../types.js";
import { type Generation, type Turn } from "./context.js";
/** Report exactly one provider attempt after its save succeeds or fails.
 * Preserve the existing native key; a dropped save uses the unique slice id in
 * its place. Retries reuse this one event, including its original timestamp. */
export declare function recordStepUsage(rt: RuntimeContext, gen: Generation, failed: boolean): Promise<void>;
/**
 * Tool bags the configured slots contribute to this turn: sandbox tools only
 * for agents that opted in. Each
 * bag gets an opaque per-slice call key.
 */
export declare function slotToolBags(rt: RuntimeContext, turn: Turn, hc: HookContext): Promise<ToolSet[]>;
/** Telemetry integrations for one generation; a throwing slot yields none. */
export declare function telemetryIntegrations(config: Registration, facts: SlotFacts, turnKey: string): import("ai").Telemetry[];
/**
 * Flush telemetry once per `runTurn` action, bounded in time.
 *
 * Race even uncooperative exporters; abort alone cannot bound an
 * arbitrary Promise. One action spends at most three seconds
 * (`LIMITS.telemetryFlushMs`). Export failures never change turn state.
 */
export declare function flushTelemetry(config: Registration, facts: SlotFacts, turnKey: string): Promise<void>;
