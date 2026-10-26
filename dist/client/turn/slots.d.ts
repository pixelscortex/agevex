import type { ToolSet } from "ai";
import type { RunnerCtx, RuntimeContext } from "../registration/context.js";
import type { MeterBackend, SlotFacts, UsageSlot } from "../slots.js";
import type { HookContext, Registration } from "../types.js";
import { type Turn } from "./context.js";
import type { TurnFence } from "./fence.js";
/** The usage slot's meter for this turn, or `undefined`. Usage is fail-open. */
export declare function meterBackend(config: Registration, ctx: RunnerCtx, facts: SlotFacts): MeterBackend | undefined;
/**
 * Meter the model step one native message save just captured.
 *
 * Agent 0.7.7 start.ts:382-417 saves step usage with its
 * native result. turns.slices.write captures the exact returned ids
 * in the same transaction; no transcript discovery is needed.
 * Only the step whose id and step order match the captured `modelStep` is
 * recorded, under an opaque per-step key, so a replayed save is idempotent.
 */
export declare function recordStepUsage(rt: RuntimeContext, turn: Turn, usage: UsageSlot, saved: unknown): Promise<void>;
/**
 * Admit the turn's attached files to the extract slot, once, at turn start.
 * Admission is the extract module's durable, deduplicated run; core never
 * retries extraction or reads its component state.
 */
export declare function extractAttachedFiles(rt: RuntimeContext, turn: Turn, fence: TurnFence): Promise<void>;
/**
 * Tool bags the configured slots contribute to this turn: sandbox tools only
 * for agents that opted in, extract tools whenever extract is configured. Each
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
