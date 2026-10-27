/** Provider evidence captured before Agent saves (Agent 0.7.7
 * vercel/client/start.ts:385-417 can throw or be fenced before usageHandler).
 * One provider step per slice; no transcript scans or inferred token counts. */
import type { MessageDoc } from "@convex-dev/agent";
import type {
  LanguageModelV4,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import type { UsageEvent } from "../slots.js";
import type { Turn } from "./context.js";

export type StepUsage = Pick<
  UsageEvent,
  "model" | "provider" | "usage" | "occurredAt" | "status"
> & {
  providerMetadata?: SharedV4ProviderMetadata;
  native?: Pick<MessageDoc, "_id" | "stepOrder">;
};

/** Retain the first completion only, even if a malformed stream finishes twice.
 * Match Agent vercel/mapping.ts:241-253's native usage vocabulary. Preserve
 * unknown counts; adding missing totals would manufacture billing evidence. */
export function captureStepUsage(
  turn: Turn,
  model: Pick<LanguageModelV4, "modelId" | "provider">,
  usage: LanguageModelV4Usage | undefined,
  reason: string,
  providerMetadata?: SharedV4ProviderMetadata,
) {
  if (!usage || turn.stepUsage) return;

  const input = usage.inputTokens;
  const output = usage.outputTokens;

  turn.stepUsage = {
    model: model.modelId,
    provider: model.provider,
    occurredAt: Date.now(),
    status: ["stop", "length", "tool-calls"].includes(reason) ? "success" : "failed",
    providerMetadata,
    usage: {
      promptTokens: input.total,
      completionTokens: output.total,
      totalTokens:
        input.total === undefined || output.total === undefined
          ? undefined
          : input.total + output.total,
      reasoningTokens: output.reasoning,
      cachedInputTokens: input.cacheRead,
      nonCachedInputTokens: input.noCache,
      cacheWriteInputTokens: input.cacheWrite,
      textOutputTokens: output.text,
      raw: usage.raw,
    },
  };
}

/** Link only the exact documents returned by this step's native write. Multiple
 * assistant/tool rows can share step usage; they still represent one call. */
export function attachUsageMessage(turn: Turn, saved: unknown) {
  const messages = (saved as { messages?: MessageDoc[] } | null)?.messages ?? [];
  const native = messages.find((message) => message.usage);

  if (turn.stepUsage && native && !turn.stepUsage.native) turn.stepUsage.native = native;
}
