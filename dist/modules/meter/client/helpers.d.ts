/**
 * Host adapters for provider evidence, observations and native Agent usage.
 * Oversized model labels use a full hash; absent cost evidence stays unknown.
 * Observation callbacks never change a provider result or retry paid work.
 * The Agent adapter requires exact step identity from its caller, never a scan.
 */
import type { UsageHandler } from "@convex-dev/agent";
import type { Meter } from "./client.js";
import type { Attribution } from "./types.js";
/** Full SHA-256 hex of a label, for ids too long to store as labels. */
export declare function hashLabel(value: string): Promise<string>;
/** Zero is evidence. Missing/invalid evidence must remain unknown, never zero. */
export declare function openRouterCost(providerMetadata: unknown): number | undefined;
/** Observe success/failure once while ensuring evidence errors never replace the paid outcome. */
export declare function observeProviderOutcome<T>(options: {
    invoke: () => Promise<T>;
    onSuccess: (result: T) => void | Promise<void>;
    onFailure?: (error: unknown) => void | Promise<void>;
    onObservationError?: (error: unknown) => void | Promise<void>;
}): Promise<T>;
/**
 * Agent 0.7.7 src/vercel/client/start.ts:425-437 calls this after each saved
 * step, but types.ts:288-302 omits message/step identity. The host must supply
 * it from its generation context (or a stable callback for a multistep call).
 * Inventing an id or scanning the transcript here would double-bill retries.
 * Embedding hooks without thread identity require a separate explicit record.
 */
export declare function usageHandlerFor(meter: Meter, options: {
    provider?: string;
    identity: (args: Parameters<UsageHandler>[1]) => Pick<Attribution, "subject" | "rootThreadId" | "runId"> & {
        messageId: string;
        step: number;
    };
}): UsageHandler;
