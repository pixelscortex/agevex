import { integer, LIMITS, text } from "../shared/limits.js";
/** Full SHA-256 hex of a label, for ids too long to store as labels. */
export async function hashLabel(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Zero is evidence. Missing/invalid evidence must remain unknown, never zero. */
export function openRouterCost(providerMetadata) {
    const metadata = providerMetadata;
    const cost = metadata?.openrouter?.usage?.cost;
    return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}
/** Observe success/failure once while ensuring evidence errors never replace the paid outcome. */
export async function observeProviderOutcome(options) {
    /** Contain both observation and observation-error failures after the provider has finished. */
    async function observe(fn) {
        try {
            await fn();
        }
        catch (error) {
            try {
                await options.onObservationError?.(error);
            }
            catch {
                /* Evidence cannot change a provider outcome. */
            }
        }
    }
    let result;
    try {
        result = await options.invoke();
    }
    catch (error) {
        await observe(() => options.onFailure?.(error));
        throw error;
    }
    await observe(() => options.onSuccess(result));
    return result;
}
/**
 * Agent 0.7.7 src/vercel/client/start.ts:425-437 calls this after each saved
 * step, but types.ts:288-302 omits message/step identity. The host must supply
 * it from its generation context (or a stable callback for a multistep call).
 * Inventing an id or scanning the transcript here would double-bill retries.
 * Embedding hooks without thread identity require a separate explicit record.
 */
export function usageHandlerFor(meter, options) {
    return async (ctx, args) => {
        if (!args.threadId)
            throw new Error("USAGE_THREAD_REQUIRED");
        const { messageId, step, ...attribution } = options.identity(args);
        text(messageId, "MESSAGE");
        integer(step, LIMITS.maxQuantity, "STEP");
        const key = JSON.stringify([args.threadId, messageId, step]);
        const scoped = meter.scope(ctx, {
            ...attribution,
            threadId: args.threadId,
            ...(args.agentName ? { agent: args.agentName } : {}),
            model: args.model,
        });
        await scoped.record(options.provider ?? args.provider, {
            key,
            usage: args.usage,
            providerMetadata: args.providerMetadata,
        });
    };
}
