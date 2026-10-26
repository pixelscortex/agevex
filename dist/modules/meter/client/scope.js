import { authorize, jobs, registered } from "./configuration.js";
import { LIMITS, integer, text } from "../shared/limits.js";
import { priceEstimate, priceRecord, usageTokens } from "./pricing.js";
import { chargeHandle } from "./handles.js";
/** Cache attribution, preserving per-call authorization and the trusted core boundary. */
function binding(meter, ctx, attributed, trusted) {
    let cached;
    const facts = async () => (cached ??= await attributed());
    const guard = async () => {
        const attribution = await facts();
        if (trusted) {
            for (const value of Object.values(attribution))
                if (value !== undefined)
                    text(value, "ATTRIBUTION");
        }
        else
            await authorize(meter, ctx, attribution);
        return attribution;
    };
    return { meter, ctx, guard };
}
/** Build the estimate writer; malformed caller input throws while unpriceable work stays unknown. */
function estimateWriter(bound, resolve) {
    const { meter, ctx, guard } = bound;
    const { component, breakdowns, sinks, limits } = meter;
    return async (requested, args) => {
        const attribution = await guard();
        const name = resolve(requested);
        const provider = registered(meter, name);
        text(args.key, "KEY", LIMITS.maxKeyBytes);
        integer(args.quantity, LIMITS.maxQuantity, "QUANTITY");
        const priced = priceEstimate(provider, args.profile, args.quantity);
        await ctx.runMutation(component.charges.create, {
            key: args.key,
            attribution,
            provider: name,
            breakdowns,
            ...(args.profile ? { profile: args.profile } : {}),
            quantity: args.quantity,
            status: priced.reason ? "unknown" : "estimate",
            source: "estimate",
            ...priced,
            sinks: sinks.map((s) => s.name),
            maxThreadCharges: limits.maxThreadCharges,
            jobs: await jobs(meter),
        });
        return chargeHandle(bound, args.key, provider);
    };
}
/** Build the inline writer; absent or invalid provider evidence still records a charge. */
function recordWriter(bound, resolve) {
    const { meter, ctx, guard } = bound;
    const { component, breakdowns, sinks, limits } = meter;
    return async (requested, args) => {
        const attribution = await guard();
        const name = resolve(requested);
        const provider = registered(meter, name);
        text(args.key, "KEY", LIMITS.maxKeyBytes);
        const priced = priceRecord(provider, {
            usage: args.usage,
            providerMetadata: args.providerMetadata,
            model: attribution.model,
        });
        if (args.requestId !== undefined)
            text(args.requestId, "REQUEST_ID");
        const tokens = usageTokens(args.usage);
        await ctx.runMutation(component.charges.create, {
            key: args.key,
            attribution,
            provider: name,
            breakdowns,
            status: priced.reason ? "unknown" : priced.source === "estimate" ? "estimate" : "settled",
            ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
            ...(tokens ? { tokens } : {}),
            ...priced,
            sinks: sinks.map((s) => s.name),
            maxThreadCharges: limits.maxThreadCharges,
            jobs: await jobs(meter),
        });
        return chargeHandle(bound, args.key, provider);
    };
}
/**
 * Host calls (`scope`) run the host `authorize` guard. Core's slot calls
 * (`trusted`) do not: their attribution is server-derived, core authorized
 * the turn when it began, and they run in background actions with no user
 * identity, where an identity-based guard would drop every charge.
 */
export function bind(meter, ctx, attributed, trusted, resolve = (name) => name) {
    const bound = binding(meter, ctx, attributed, trusted);
    return { estimate: estimateWriter(bound, resolve), record: recordWriter(bound, resolve) };
}
/** Bind explicit host attribution; the subject guard remains eager, all other checks lazy. */
export function scope(meter, ctx, attribution) {
    text(attribution.subject, "SUBJECT");
    return bind(meter, ctx, async () => attribution, false);
}
