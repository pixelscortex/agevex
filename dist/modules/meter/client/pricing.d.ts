/**
 * Provider evidence and estimate pricing for the host meter client.
 * Scope writers and lookup workers share the same nanodollar conversion.
 * Unpriceable business outcomes become unknown charges so the budget gate
 * fails closed; malformed caller keys and quantities are validated elsewhere.
 */
import type { Cost, Provider, UnknownReason } from "./types.js";
/** Build the inline evidence adapter used when saved model steps are recorded. */
export declare function inline(decode?: NonNullable<Provider["inline"]>): Provider;
/** Resolve the bounded billing-evidence window when registering or attaching a provider. */
export declare function lookupMs(provider: Provider): number;
/** Amounts up to maxBilledNanos are representable; above maxChargeNanos the
 * mutation or `capped` turns them into `unknown` / OVER_CAP, keeping the amount. */
export declare function costNanos(provider: Provider, cost: Cost): {
    nanos: number;
    credits?: undefined;
} | {
    nanos: number;
    credits: number;
};
type Priced = {
    nanos?: number;
    credits?: number;
    reason?: UnknownReason;
};
/**
 * Core records model steps under `message.provider ?? "model"` and swallows
 * meter errors (`recordStepUsage` in src/client/turn/slots.ts), so a throw here would drop the
 * charge and the budget gate would admit unmetered work. Every business
 * condition that prevents pricing becomes an `unknown` charge with a reason
 * instead; `check` denies while any unknown charge exists.
 */
export declare function priceInline(provider: Provider | undefined, evidence: Parameters<NonNullable<Provider["inline"]>>[0]): Priced;
/** Same rule for estimates, which managed tools reach through core's slot. */
export declare function priceEstimate(provider: Provider | undefined, profile: string | undefined, quantity: number): Priced;
/** Price saved usage from inline evidence first, then a host's token estimate. */
export declare function priceRecord(provider: Provider | undefined, evidence: Parameters<NonNullable<Provider["inline"]>>[0] & {
    model?: string;
}): {
    source: "inline";
    nanos?: number;
    credits?: number;
    reason?: UnknownReason;
} | {
    source: "estimate";
    nanos?: number;
    credits?: number;
    reason?: UnknownReason;
};
/** Preserve token absence rather than fabricating zero; supports native and V4 usage. */
export declare function usageTokens(usage: unknown): {
    inputTokens: number;
    outputTokens: number;
} | undefined;
/** Host-configured rates, never guessed from a model name or a remote catalog. */
export declare function tokenEstimate(rates: {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
}): NonNullable<Provider["estimate"]>;
export {};
