import type { ToolSet } from "ai";
import type { RuntimeContext } from "../registration/context.js";
import type { SlotFacts, UsageSlot } from "../slots.js";
import type { HookContext, Registration } from "../types.js";
import { type Turn } from "./context.js";
/**
 * Report the model step one native message save just captured.
 *
 * Agent 0.7.7 start.ts:382-417 saves step usage with its
 * native result. turns.slices.write returns those committed documents;
 * no transcript discovery is needed.
 * The fenced native save returns the committed document and exact identity;
 * no duplicate step reference or follow-up execution read is needed.
 */
export declare function recordStepUsage(rt: RuntimeContext, turn: Turn, usage: UsageSlot, saved: unknown): Promise<void>;
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
