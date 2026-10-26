import { type Tool } from "ai";
import type { z } from "zod";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { Value } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
export { fingerprint } from "./keys.js";
import { type MeterBackend, type ScopedMeter } from "./slots.js";
export { noopMeter } from "./slots.js";
export type { ScopedMeter, MeterCharge } from "./slots.js";
export type ToolContext = {
    ctx: GenericActionCtx<GenericDataModel>;
    subject: string;
    rootThreadId: string;
    agent: string;
    threadId: string;
    runId: string;
    /** Bounded opaque id; the provider id remains available for attribution. */
    toolCallId: string;
    nativeToolCallId?: string;
    signal: AbortSignal;
    meter: ScopedMeter;
};
type OnceConfig<Input, Output> = {
    name: string;
    /** What the model reads when choosing the tool; defaults to `name`. */
    description?: string;
    input: z.ZodType<Input>;
    run: (input: Input, context: ToolContext) => Promise<Output> | Output;
    key?: (input: Input, context: ToolContext) => string;
    repeatSafe?: boolean;
    leaseMs?: number;
};
/**
 * Opt a tool into the shared receipts ledger. Unknown outcomes are visible to
 * the model and never silently retried. Only repeatSafe permits reclaiming an
 * expired claim. Large results should return a storage id within the bound.
 */
export declare function defineOnceTool<Input, Output extends Value>(config: OnceConfig<Input, Output>): Tool<Input, Output>;
/**
 * Bind one declared tool to the turn's receipts ledger and fence.
 *
 * Returns the tool unchanged unless it was made by `defineOnceTool`. A bound
 * tool admits each call through `receipts.effects.begin` under a per-subject, per-thread,
 * per-tool scope and a key from `config.key` (or the call id): a repeated key
 * returns the stored result, a different payload under the same key is a
 * `KEY_CONFLICT`, and a throwing `run` stores a sanitized `TOOL_FAILED`. The
 * fence makes a write from a cancelled turn fail instead of landing.
 */
export declare function bindOnceTool(declared: Tool, component: ComponentApi, rawCtx: GenericActionCtx<GenericDataModel>, context: Omit<ToolContext, "toolCallId">, fence: {
    assignmentId: string;
    executionId: string;
    cancellationEpoch: number;
}, leaseMs: number, backend?: MeterBackend): Tool;
