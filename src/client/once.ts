import { tool, type Tool, type ToolExecutionOptions } from "ai";
import type { z } from "zod";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { Value } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";

export type ToolContext = {
  ctx: GenericActionCtx<GenericDataModel>;
  subject: string;
  threadId: string;
  runId: string;
  toolCallId: string;
  signal: AbortSignal;
};
const ONCE = Symbol("agevex.once");
type OnceConfig<Input, Output> = {
  name: string;
  input: z.ZodType<Input>;
  run: (input: Input, context: ToolContext) => Promise<Output> | Output;
  key?: (input: Input, context: ToolContext) => string;
  repeatSafe?: boolean;
  leaseMs?: number;
};

/** Stable JSON for fingerprints: object property order is not part of an input. */
export async function fingerprint(input: unknown): Promise<string> {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(input))),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

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
      description: config.name,
      inputSchema: config.input,
      execute: async (): Promise<Output> => {
        throw new Error("MANAGED_TOOL_CONTEXT_REQUIRED");
      },
    } as unknown as Tool<Input, Output>),
    { [ONCE]: config },
  );
}

export function bindOnceTool(
  declared: Tool,
  component: ComponentApi,
  rawCtx: GenericActionCtx<GenericDataModel>,
  context: Omit<ToolContext, "toolCallId">,
  fence: { assignmentId: string; executionId: string; cancellationEpoch: number },
): Tool {
  const config = (declared as Tool & { [ONCE]?: OnceConfig<unknown, Value> })[ONCE];
  if (!config) return declared;
  return {
    ...declared,
    execute: async (input: unknown, options: ToolExecutionOptions<any>) => {
      const tc = { ...context, toolCallId: options.toolCallId };
      const scope = `tool:${tc.subject}:${tc.threadId}:${config.name}`;
      const key = config.key?.(input, tc) ?? tc.toolCallId;
      const common = { scope, key, ...fence };
      const admission = await rawCtx.runMutation(component.ledger.begin, {
        ...common,
        fingerprint: await fingerprint(input),
        repeatSafe: config.repeatSafe,
        leaseMs: config.leaseMs,
      });
      if (admission.status === "done" || admission.status === "failed") return admission.result;
      if (admission.status !== "claimed")
        return admission.status === "conflict"
          ? { status: "denied", code: "KEY_CONFLICT" }
          : { status: admission.status };
      try {
        const result = await config.run(input, tc);
        await rawCtx.runMutation(component.ledger.complete, {
          ...common,
          claim: admission.claim,
          result,
        });
        return result;
      } catch {
        const result = { status: "failed", code: "TOOL_FAILED" };
        await rawCtx.runMutation(component.ledger.complete, {
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
