/** Provider evidence captured before Agent saves (Agent 0.7.7
 * vercel/client/start.ts:385-417 can throw or be fenced before usageHandler).
 * One provider step per slice; no transcript scans or inferred token counts. */
import type { MessageDoc } from "@convex-dev/agent";
import type { LanguageModelV4, LanguageModelV4Usage, SharedV4ProviderMetadata } from "@ai-sdk/provider";
import type { UsageEvent } from "../slots.js";
import type { Turn } from "./context.js";
import type { TurnFence } from "./fence.js";
export type StepUsage = Pick<UsageEvent, "model" | "provider" | "usage" | "occurredAt" | "status"> & {
    providerMetadata?: SharedV4ProviderMetadata;
    native?: Pick<MessageDoc, "_id" | "stepOrder">;
};
/** Retain the first completion only, even if a malformed stream finishes twice.
 * Match Agent vercel/mapping.ts:241-253's native usage vocabulary. Preserve
 * unknown counts; adding missing totals would manufacture billing evidence. */
export declare function captureStepUsage(turn: Turn, model: Pick<LanguageModelV4, "modelId" | "provider">, usage: LanguageModelV4Usage | undefined, reason: string, providerMetadata?: SharedV4ProviderMetadata): void;
/** Link only the exact documents returned by this step's native write. Multiple
 * assistant/tool rows can share step usage; they still represent one call. */
export declare function attachUsageMessage(turn: Turn, saved: unknown): void;
/** Track completion before dispatch, including handle preparation. Agent 0.7.7
 * component/messages.ts:364-388 replaces the exact pending id with the first
 * response row. Retain that id so a lost reply cannot choose a different key. */
export declare function trackUsageSave(turn: Turn, payload: unknown, invoke: () => Promise<unknown>): Promise<unknown>;
/** Wait for the outstanding save while the fence is live. After revocation,
 * recover a committed replacement by its exact pre-recorded id, never history.
 * One native document <=1 MiB is read, even at hard maximum host settings.
 * Recovery gets the existing 1s evidence bound after abort, like the final hook.
 * An unresolved save is unknown, not a dropped save: mark partial rather than
 * emitting a fallback key that a late commit would make incorrect. */
export declare function settleUsageSave(turn: Turn, fence: TurnFence): Promise<void>;
