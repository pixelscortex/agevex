import { opaqueKey } from "./keys.js";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { Telemetry, ToolSet } from "ai";
import type { ToolContext } from "./once.js";

/** All semantic facts are nonempty and at most LIMITS.factBytes (128 UTF-8 bytes).
 * Opaque keys are full SHA-256 hex (64 bytes); original facts stay in attribution.
 * Server-derived attribution. Optional modules depend on this contract; core
 * never depends on their components, provider clients or storage formats. */
export type SlotFacts = {
  subject: string;
  rootThreadId: string;
  threadId: string;
  runId: string;
  agent: string;
};
export type SlotActionCtx = GenericActionCtx<GenericDataModel>;
export type ChargeCost = { usd: number; credits?: never } | { credits: number; usd?: never };
export type MeterChargeBackend = {
  key: string;
  attach(args: { requestId: string; key: string }): Promise<unknown>;
  correct(args: { quantity: number; key: string }): Promise<unknown>;
  settle(args: ChargeCost & { key: string }): Promise<unknown>;
  get(): Promise<unknown>;
};
export type MeterBackend = {
  estimate(
    provider: string,
    args: { key: string; profile?: string; quantity: number },
  ): Promise<MeterChargeBackend>;
  record(
    provider: string,
    args: { key: string; usage?: unknown; providerMetadata?: unknown },
  ): Promise<MeterChargeBackend>;
};
export type UsageSlot = {
  scope(ctx: SlotActionCtx, facts: SlotFacts & { model?: string }): MeterBackend;
};
export type BudgetSlot = {
  check(
    ctx: SlotActionCtx,
    args: { subject: string; runId: string },
  ): Promise<{ allowed: boolean }>;
};
export type TelemetrySlot = {
  integration(facts: SlotFacts & { turnKey: string }): Telemetry;
  flush(facts: SlotFacts & { turnKey: string }, signal?: AbortSignal): Promise<void>;
};
export type SandboxSlot = {
  tools(context: ToolContext): ToolSet;
};
export type ExtractSlot = {
  /** `subject` is the server-derived owner of the thread, so the adapter can
   * authorize with `runtime.fileAttached` without reading core state. */
  run(
    ctx: SlotActionCtx,
    args: { fileId: string; threadId: string; subject: string },
  ): Promise<unknown>;
  tools(context: ToolContext): ToolSet;
};

/** Public tool facade: the backend requires stable keys; managed calls supply
 * them automatically. Explicit keys allow several logically distinct charges. */
export type MeterCharge = {
  key: string;
  attach(args: { requestId: string; key?: string }): Promise<unknown>;
  correct(args: { quantity: number; key?: string }): Promise<unknown>;
  settle(args: ChargeCost & { key?: string }): Promise<unknown>;
  get(): Promise<unknown>;
};
export type ScopedMeter = {
  estimate(
    provider: string,
    args: { key?: string; profile?: string; quantity: number },
  ): Promise<MeterCharge>;
  record(
    provider: string,
    args: { key?: string; usage?: unknown; providerMetadata?: unknown },
  ): Promise<MeterCharge>;
};
const noCharge: MeterCharge = {
  key: "noop",
  attach: async () => {},
  correct: async () => {},
  settle: async () => {},
  get: async () => null,
};
export const noopMeter: ScopedMeter = {
  estimate: async () => noCharge,
  record: async () => noCharge,
};

export function scopedMeter(backend: MeterBackend | undefined, callKey: string): ScopedMeter {
  if (!backend) return noopMeter;
  // Counters are local to one deterministic invocation. Method suffixes prevent
  // attach/correct/settle from colliding in the meter's shared operation ledger.
  let ordinal = 0;
  const wrap = (charge: MeterChargeBackend): MeterCharge => {
    const counts = { attach: 0, correct: 0, settle: 0 };
    return {
      key: charge.key,
      get: () => charge.get(),
      attach: async (args) =>
        charge.attach({
          ...args,
          key: await opaqueKey("operation", charge.key, "attach", args.key ?? counts.attach++),
        }),
      correct: async (args) =>
        charge.correct({
          ...args,
          key: await opaqueKey("operation", charge.key, "correct", args.key ?? counts.correct++),
        }),
      settle: async (args) =>
        charge.settle({
          ...args,
          key: await opaqueKey("operation", charge.key, "settle", args.key ?? counts.settle++),
        }),
    };
  };
  return {
    estimate: async (provider, args) =>
      wrap(
        await backend.estimate(provider, {
          ...args,
          key: await opaqueKey("charge", callKey, args.key ?? ordinal++),
        }),
      ),
    record: async (provider, args) =>
      wrap(
        await backend.record(provider, {
          ...args,
          key: await opaqueKey("charge", callKey, args.key ?? ordinal++),
        }),
      ),
  };
}
