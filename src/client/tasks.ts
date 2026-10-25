import { generateText, Output, NoObjectGeneratedError, type LanguageModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { convexToJson, getConvexSize, type Value } from "convex/values";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { z } from "zod";
import type { ComponentApi } from "../component/_generated/component.js";
import { HOST_LIMITS, LIMITS } from "../component/limits.js";
import { fingerprint, opaqueKey } from "./keys.js";
import { assertFact } from "../component/facts.js";
import type { SlotFacts, UsageSlot } from "./slots.js";

type TaskModel = Extract<LanguageModel, string | LanguageModelV4>;
export type Task<Input, Output> = {
  name: string;
  input: z.ZodType<Input>;
  output: z.ZodType<Output>;
  prompt: (input: Input) => string;
  model?: TaskModel;
  repair?: 0 | 1;
};
export type TaskOptions = {
  key?: string;
  component?: ComponentApi;
  attribution?: SlotFacts;
  usage?: UsageSlot;
  model?: TaskModel;
  leaseMs?: number;
  signal?: AbortSignal;
};
export type TaskOutcome<Output> =
  | { status: "done"; value: Output }
  | { status: "running" | "unknown" }
  | { status: "failed"; code: "TASK_FAILED" | "INVALID_OUTPUT" }
  | { status: "denied"; code: "KEY_CONFLICT" | "CANCELLED" };
type ActionCtx = GenericActionCtx<GenericDataModel>;
type Binding = {
  component: ComponentApi;
  attribution: SlotFacts;
  usage?: UsageSlot;
  turnKey: string;
  fence?: { assignmentId: string; executionId: string; cancellationEpoch: number };
};
// Action-local capabilities are never serialized into Workflow arguments. Hook
// calls use the same receipts and cancellation fence as managed tool effects.
const bindings = new WeakMap<object, Binding>();
export function bindTaskContext(ctx: ActionCtx, binding: Binding) {
  bindings.set(ctx, binding);
}

/** Thin schema/prompt declaration. SDK Output.object owns parsing and validation
 * (ai/src/generate-text/output.ts:127-167); receipts only guard paid admission. */
export function defineTask<Input, Output>(task: Task<Input, Output>): Task<Input, Output> {
  if (
    !task.name ||
    task.name.length > LIMITS.requestKeyLength ||
    typeof task.prompt !== "function" ||
    (task.repair !== undefined && task.repair !== 0 && task.repair !== LIMITS.taskRepairs)
  )
    throw new Error("INVALID_TASK");
  return { ...task };
}

export async function runTask<Input, Output>(
  context: ActionCtx | { ctx: ActionCtx; signal: AbortSignal },
  task: Task<Input, Output>,
  input: Input,
  options: TaskOptions = {},
): Promise<TaskOutcome<Output>> {
  const ctx = "ctx" in context ? context.ctx : context;
  const binding = bindings.get(ctx);
  const component = binding?.component ?? options.component;
  const attribution = binding?.attribution ?? options.attribution;
  if (!component || !attribution) throw new Error("TASK_CONTEXT_REQUIRED");
  const key =
    options.key ??
    (binding
      ? await opaqueKey("hook-task", attribution.runId, binding.turnKey, task.name)
      : undefined);
  if (!key || key.length > LIMITS.requestKeyLength) throw new Error("INVALID_TASK_KEY");
  for (const key of ["subject", "rootThreadId", "threadId", "runId", "agent"] as const) {
    assertFact(attribution[key], key, "INVALID_TASK_ATTRIBUTION");
  }
  const leaseMs = options.leaseMs ?? LIMITS.leaseMs;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > HOST_LIMITS.leaseMs.max)
    throw new Error("INVALID_TASK_LEASE");
  const model = options.model ?? task.model;
  if (!model) throw new Error("TASK_MODEL_REQUIRED");
  const parsed = await task.input.parseAsync(input);
  const prompt = task.prompt(parsed);
  if (!prompt.trim() || prompt.length > LIMITS.taskPromptLength)
    throw new Error("INVALID_TASK_PROMPT");
  const signal = "ctx" in context ? context.signal : options.signal;
  if (signal?.aborted) return { status: "denied", code: "CANCELLED" };
  const scope = `task:${await fingerprint([attribution.subject, attribution.threadId, task.name])}`;
  const common = { scope, key, ...binding?.fence };
  const admission = await ctx.runMutation(component.ledger.begin, {
    ...common,
    fingerprint: await fingerprint([
      parsed,
      prompt,
      typeof model === "string" ? model : [model.provider, model.modelId],
    ]),
    leaseMs,
  });
  if (admission.status === "done" || admission.status === "failed")
    return admission.result as TaskOutcome<Output>;
  if (admission.status === "conflict") return { status: "denied", code: "KEY_CONFLICT" };
  if (admission.status === "stale") return { status: "denied", code: "CANCELLED" };
  if (admission.status !== "claimed") return { status: admission.status };
  const record = async (attempt: number, usage: unknown, providerMetadata: unknown) => {
    try {
      const provider = typeof model === "string" ? model.split("/")[0] : model.provider;
      await (binding?.usage ?? options.usage)
        ?.scope(ctx, { ...attribution, model: typeof model === "string" ? model : model.modelId })
        .record(provider, {
          key: await opaqueKey("task-usage", scope, key, attempt),
          usage,
          providerMetadata,
        });
    } catch {
      /* Recording evidence must never trigger another paid call. */
    }
  };
  let result: TaskOutcome<Output> = { status: "failed", code: "TASK_FAILED" };
  try {
    let repairText: string | undefined;
    for (let attempt = 0; attempt <= (task.repair ?? LIMITS.taskRepairs); attempt++) {
      // Admission owns the authoritative deadline. A known invalid first answer
      // does not authorize another paid attempt after that claim has expired.
      if (Date.now() >= admission.leaseUntil) {
        await ctx.runMutation(component.ledger.unknown, { ...common, claim: admission.claim });
        return { status: "unknown" };
      }
      try {
        const generated = await generateText({
          model,
          output: Output.object({ schema: task.output }),
          prompt:
            repairText === undefined
              ? prompt
              : `${prompt}\n\nYour previous response did not match the output schema. Return valid JSON matching the schema.\nPrevious response:\n${repairText}`,
          maxRetries: LIMITS.modelRetries,
          maxOutputTokens: LIMITS.outputTokens,
          abortSignal: signal,
        });
        // Output validation can throw. Read it before recording so an invalid
        // answer is charged only by the repair/error path below.
        const value = generated.output;
        await record(attempt, generated.usage, generated.providerMetadata);
        // Convex validates the serializable result and its byte bound before
        // persistence. A huge response never becomes a >1 MiB receipt document.
        convexToJson(value as Value);
        result = { status: "done", value };
        if (getConvexSize(result as Value) > LIMITS.receiptResultBytes)
          result = { status: "failed", code: "INVALID_OUTPUT" };
        break;
      } catch (error) {
        if (!NoObjectGeneratedError.isInstance(error)) {
          await record(attempt, undefined, undefined);
          throw error;
        }
        await record(attempt, error.usage, undefined);
        result = { status: "failed", code: "INVALID_OUTPUT" };
        // Only invalid structured output permits one intentional re-ask. A
        // transport error/unknown paid outcome is never repaired or retried.
        if (
          error.text === undefined ||
          error.text.length > LIMITS.taskPromptLength ||
          signal?.aborted
        )
          break;
        repairText = error.text;
      }
    }
  } catch {
    await ctx.runMutation(component.ledger.unknown, { ...common, claim: admission.claim });
    return { status: "unknown" };
  }
  await ctx.runMutation(component.ledger.complete, {
    ...common,
    claim: admission.claim,
    result,
    failed: result.status === "failed",
  });
  // complete refuses late claims. Read the same receipt admission back rather
  // than claiming a result that was discarded after lease expiry/cancellation.
  const committed = await ctx.runMutation(component.ledger.begin, {
    ...common,
    fingerprint: await fingerprint([
      parsed,
      prompt,
      typeof model === "string" ? model : [model.provider, model.modelId],
    ]),
    leaseMs,
  });
  if (committed.status === "done" || committed.status === "failed")
    return committed.result as TaskOutcome<Output>;
  return committed.status === "stale"
    ? { status: "denied", code: "CANCELLED" }
    : { status: "unknown" };
}
