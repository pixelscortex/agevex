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
    purpose?: "agent" | "hook" | "tool" | "title" | "summary";
    /** Delegation identity; absent on the root node. Never supplied by the model. */
    nodeId?: string;
};
export type UsageView = {
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedUsd: number;
    settledUsd: number;
    unknown: number;
    reporting: "available" | "partial";
};
export type UsageViewArgs = {
    subject: string;
    runId: string;
    /** At most 59 exclusive nodes, already discovered by the caller; null is root. */
    nodeIds: (string | null)[];
    partial?: boolean;
};
export type UsageProjection = {
    total: UsageView;
    nodes: {
        nodeId: string | null;
        usage: UsageView;
    }[];
};
export type SlotReadCtx = Pick<SlotActionCtx, "runQuery" | "auth">;
export type SlotActionCtx = GenericActionCtx<GenericDataModel>;
export type ChargeCost = {
    usd: number;
    credits?: never;
} | {
    credits: number;
    usd?: never;
};
export type MeterChargeBackend = {
    key: string;
    attach(args: {
        requestId: string;
        key: string;
    }): Promise<unknown>;
    correct(args: {
        quantity: number;
        key: string;
    }): Promise<unknown>;
    settle(args: ChargeCost & {
        key: string;
    }): Promise<unknown>;
    get(): Promise<unknown>;
};
export type MeterBackend = {
    estimate(provider: string, args: {
        key: string;
        profile?: string;
        quantity: number;
    }): Promise<MeterChargeBackend>;
    record(provider: string, args: {
        key: string;
        usage?: unknown;
        providerMetadata?: unknown;
        requestId?: string;
    }): Promise<MeterChargeBackend>;
};
export type UsageSlot = {
    scope(ctx: SlotActionCtx, facts: SlotFacts & {
        model?: string;
    }): MeterBackend;
    view?(ctx: SlotReadCtx, args: UsageViewArgs): Promise<UsageProjection>;
    /** On-demand, read-only evidence discovery; never invokes a model. */
    reconcile?(ctx: SlotActionCtx, args: {
        subject: string;
        runId: string;
    }): Promise<unknown>;
};
export type BudgetSlot = {
    check(ctx: SlotActionCtx, args: {
        subject: string;
        runId: string;
    }): Promise<{
        allowed: boolean;
    }>;
};
export type TelemetrySlot = {
    integration(facts: SlotFacts & {
        turnKey: string;
    }): Telemetry;
    flush(facts: SlotFacts & {
        turnKey: string;
    }, signal?: AbortSignal): Promise<void>;
};
export type SandboxSlot = {
    tools(context: ToolContext): ToolSet;
};
export type ExtractSlot = {
    /** `subject` is the server-derived owner of the thread, so the adapter can
     * authorize with `runtime.fileAttached` without reading core state. */
    run(ctx: SlotActionCtx, args: {
        fileId: string;
        threadId: string;
        subject: string;
    }): Promise<unknown>;
    tools(context: ToolContext): ToolSet;
};
/** Public tool facade: the backend requires stable keys; managed calls supply
 * them automatically. Explicit keys allow several logically distinct charges. */
export type MeterCharge = {
    key: string;
    attach(args: {
        requestId: string;
        key?: string;
    }): Promise<unknown>;
    correct(args: {
        quantity: number;
        key?: string;
    }): Promise<unknown>;
    settle(args: ChargeCost & {
        key?: string;
    }): Promise<unknown>;
    get(): Promise<unknown>;
};
export type ScopedMeter = {
    estimate(provider: string, args: {
        key?: string;
        profile?: string;
        quantity: number;
    }): Promise<MeterCharge>;
    record(provider: string, args: {
        key?: string;
        usage?: unknown;
        providerMetadata?: unknown;
        requestId?: string;
    }): Promise<MeterCharge>;
};
export declare const noopMeter: ScopedMeter;
/**
 * The meter a hook or tool call sees. Without a backend it is the no-op meter.
 *
 * Every charge key is derived from `callKey` plus an explicit key or a local
 * ordinal, and every charge operation key from the charge key plus the method,
 * so a replayed call reproduces exactly the same keys and the backend dedupes.
 */
export declare function scopedMeter(backend: MeterBackend | undefined, callKey: string): ScopedMeter;
