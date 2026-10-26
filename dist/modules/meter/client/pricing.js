import { LIMITS, integer, nanos } from "../shared/limits.js";
import { openRouterCost } from "./helpers.js";
/** Build the inline evidence adapter used when saved model steps are recorded. */
export function inline(decode = ({ providerMetadata }) => {
    const usd = openRouterCost(providerMetadata);
    return usd === undefined ? undefined : { usd };
}) {
    return { inline: decode };
}
/** Resolve the bounded billing-evidence window when registering or attaching a provider. */
export function lookupMs(provider) {
    return provider.lookupFor === "1h"
        ? LIMITS.lookupMs
        : provider.lookupFor === "1d"
            ? LIMITS.maxLookupMs
            : (provider.lookupFor ?? LIMITS.lookupMs);
}
/** Amounts up to maxBilledNanos are representable; above maxChargeNanos the
 * mutation or `capped` turns them into `unknown` / OVER_CAP, keeping the amount. */
export function costNanos(provider, cost) {
    if ("usd" in cost && "credits" in cost)
        throw new Error("AMBIGUOUS_COST");
    if ("usd" in cost)
        return { nanos: nanos(cost.usd, LIMITS.maxBilledNanos) };
    integer(cost.credits, LIMITS.maxQuantity, "CREDITS");
    if (!provider.credits)
        throw new Error("CREDIT_RATE_REQUIRED");
    return {
        nanos: nanos(cost.credits * provider.credits.usdPerCredit, LIMITS.maxBilledNanos),
        credits: cost.credits,
    };
}
/** Keep a known amount above the per-charge cap: unknown for the gate, still billed. */
function capped(priced) {
    return priced.nanos > LIMITS.maxChargeNanos ? { ...priced, reason: "OVER_CAP" } : priced;
}
/** Above the per-charge cap is OVER_CAP; any other malformed amount is INVALID_COST. */
function unpriced(error) {
    return {
        reason: error instanceof Error && error.message === "INVALID_NANOS" ? "OVER_CAP" : "INVALID_COST",
    };
}
/**
 * Core records model steps under `message.provider ?? "model"` and swallows
 * meter errors (`recordStepUsage` in src/client/turn/slots.ts), so a throw here would drop the
 * charge and the budget gate would admit unmetered work. Every business
 * condition that prevents pricing becomes an `unknown` charge with a reason
 * instead; `check` denies while any unknown charge exists.
 */
export function priceInline(provider, evidence) {
    if (!provider)
        return { reason: "PROVIDER_NOT_REGISTERED" };
    let cost;
    try {
        cost = provider.inline?.(evidence);
    }
    catch {
        return { reason: "DECODE_FAILED" };
    }
    if (!cost)
        return { reason: "NO_COST" };
    try {
        return capped(costNanos(provider, cost));
    }
    catch (error) {
        return unpriced(error);
    }
}
/** Same rule for estimates, which managed tools reach through core's slot. */
export function priceEstimate(provider, profile, quantity) {
    if (!provider)
        return { reason: "PROVIDER_NOT_REGISTERED" };
    if (!profile)
        return {};
    const price = provider.profiles?.[profile];
    if (!price)
        return { reason: "PROFILE_NOT_REGISTERED" };
    try {
        return capped({ nanos: nanos(price.usd * quantity, LIMITS.maxBilledNanos) });
    }
    catch (error) {
        return unpriced(error);
    }
}
/** Price saved usage from inline evidence first, then a host's token estimate. */
export function priceRecord(provider, evidence) {
    const priced = priceInline(provider, evidence);
    if (priced.reason !== "NO_COST" || !provider?.estimate)
        return { ...priced, source: "inline" };
    try {
        const cost = provider.estimate(evidence);
        return { ...(cost ? capped(costNanos(provider, cost)) : priced), source: "estimate" };
    }
    catch {
        return { reason: "DECODE_FAILED", source: "estimate" };
    }
}
/** Preserve token absence rather than fabricating zero; supports native and V4 usage. */
export function usageTokens(usage) {
    const value = usage;
    const inputTokens = typeof value?.inputTokens === "object"
        ? value.inputTokens?.total
        : (value?.inputTokens ?? value?.promptTokens);
    const outputTokens = typeof value?.outputTokens === "object"
        ? value.outputTokens?.total
        : (value?.outputTokens ?? value?.completionTokens);
    if (inputTokens === undefined || outputTokens === undefined)
        return undefined;
    try {
        integer(inputTokens, LIMITS.maxTokens, "TOKENS");
        integer(outputTokens, LIMITS.maxTokens, "TOKENS");
        return { inputTokens, outputTokens };
    }
    catch {
        return undefined;
    }
}
/** Host-configured rates, never guessed from a model name or a remote catalog. */
export function tokenEstimate(rates) {
    nanos(rates.inputUsdPerMillion);
    nanos(rates.outputUsdPerMillion);
    return ({ usage }) => {
        const tokens = usageTokens(usage);
        return tokens
            ? {
                usd: (tokens.inputTokens * rates.inputUsdPerMillion +
                    tokens.outputTokens * rates.outputUsdPerMillion) /
                    LIMITS.tokensPerMillion,
            }
            : undefined;
    };
}
