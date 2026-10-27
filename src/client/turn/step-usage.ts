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
import type { TurnFence } from "./fence.js";
import { boundedUsageCall } from "./usage.js";

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

/** Track completion before dispatch, including handle preparation. Agent 0.7.7
 * component/messages.ts:364-388 replaces the exact pending id with the first
 * response row. Retain that id so a lost reply cannot choose a different key. */
export function trackUsageSave(turn: Turn, payload: unknown, invoke: () => Promise<unknown>) {
  const args = payload as { pendingMessageId?: string; messages?: { usage?: unknown }[] };

  const pending = invoke().then((saved) => {
    attachUsageMessage(turn, saved);

    return saved;
  });

  if (args.messages?.some((message) => message.usage)) {
    const save = { messageId: args.pendingMessageId, pending, settled: false };

    turn.usageSave = save;

    void pending.then(
      () => {
        save.settled = true;
      },
      () => {
        save.settled = true;
      },
    );
  }

  return pending;
}

/** Wait for the outstanding save while the fence is live. After revocation,
 * recover a committed replacement by its exact pre-recorded id, never history.
 * One native document <=1 MiB is read, even at hard maximum host settings.
 * Recovery gets the existing 1s evidence bound after abort, like the final hook.
 * An unresolved save is unknown, not a dropped save: mark partial rather than
 * emitting a fallback key that a late commit would make incorrect. */
export async function settleUsageSave(turn: Turn, fence: TurnFence) {
  const save = turn.usageSave;

  if (!save || turn.stepUsage?.native) return;

  try {
    await fence.wait(save.pending);
  } catch {
    // A failed reply does not prove rollback. Read the exact native row below.
  }

  if (turn.stepUsage?.native) return;

  if (save.messageId) {
    const recover = boundedUsageCall(() =>
      turn.rawCtx.runQuery(turn.managed.component.messages.getMessagesByIds, {
        messageIds: [save.messageId!],
      }),
    );

    const messages = fence.controller.signal.aborted ? await recover : await fence.wait(recover);

    attachUsageMessage(turn, { messages });
  }

  if (!turn.stepUsage?.native && !save.settled) throw new Error("USAGE_SAVE_UNKNOWN");
}
