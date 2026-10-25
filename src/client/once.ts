// Exactly-once host tools on the shared receipts ledger.
//
// `defineOnceTool` marks a tool whose effect must happen at most once per key;
// `bindOnceTool` (called for every tool by `turn/tools.ts`) turns that marker into
// a ledger-guarded execute: `receipts.effects.begin` admits or replays, `receipts.effects.complete`
// stores the result or a sanitized failure, and an unknown outcome is surfaced to
// the model instead of retried. Unmarked tools pass through unchanged.

import { tool, type Tool, type ToolExecutionOptions } from "ai";
import type { z } from "zod";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { Value } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";

import { fingerprint, opaqueKey } from "./keys.js";
export { fingerprint } from "./keys.js";
import { scopedMeter, type MeterBackend, type ScopedMeter } from "./slots.js";
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
const ONCE = Symbol("agevex.once");
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
export function defineOnceTool<Input, Output extends Value>(
  config: OnceConfig<Input, Output>,
): Tool<Input, Output> {
  return Object.assign(
    tool({
      description: config.description ?? config.name,
      inputSchema: config.input,
      execute: async (): Promise<Output> => {
        throw new Error("MANAGED_TOOL_CONTEXT_REQUIRED");
      },
    } as unknown as Tool<Input, Output>),
    { [ONCE]: config },
  );
}

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
export function bindOnceTool(
  declared: Tool,
  component: ComponentApi,
  rawCtx: GenericActionCtx<GenericDataModel>,
  context: Omit<ToolContext, "toolCallId">,
  fence: { assignmentId: string; executionId: string; cancellationEpoch: number },
  leaseMs: number,
  backend?: MeterBackend,
): Tool {
  const config = (declared as Tool & { [ONCE]?: OnceConfig<unknown, Value> })[ONCE];
  if (!config) return declared;

  return {
    ...declared,
    execute: async (input: unknown, options: ToolExecutionOptions<any>) => {
      const tc = {
        ...context,
        toolCallId: options.toolCallId,
        nativeToolCallId:
          (options.context as ToolContext | undefined)?.nativeToolCallId ?? options.toolCallId,
        meter: scopedMeter(backend, options.toolCallId),
      };

      const scope = await opaqueKey("tool", tc.subject, tc.threadId, config.name);
      const key = await opaqueKey("once", config.key?.(input, tc) ?? tc.toolCallId);
      const common = { scope, key, ...fence };
      const admission = await rawCtx.runMutation(component.receipts.effects.begin, {
        ...common,
        fingerprint: await fingerprint(input),
        repeatSafe: config.repeatSafe,
        leaseMs: config.leaseMs ?? leaseMs,
      });
      if (admission.status === "done" || admission.status === "failed") return admission.result;
      if (admission.status !== "claimed")
        return admission.status === "conflict"
          ? { status: "denied", code: "KEY_CONFLICT" }
          : { status: admission.status };

      try {
        const result = await config.run(input, tc);
        await rawCtx.runMutation(component.receipts.effects.complete, {
          ...common,
          claim: admission.claim,
          result,
        });
        return result;
      } catch {
        const result = { status: "failed", code: "TOOL_FAILED" };
        await rawCtx.runMutation(component.receipts.effects.complete, {
          ...common,
          claim: admission.claim,
          result,
          failed: true,
        });
        return result;
      }
    },
  };
}
