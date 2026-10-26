import { resolveBreakdowns } from "../shared/breakdowns.js";
import { LIMITS, integer, text } from "../shared/limits.js";
import { find, stale } from "./charge-records.js";
import { validateJobs } from "./jobs.js";
import { rootOf, threadCount, updateAggregates } from "./aggregates.js";
import { prepareSinks } from "./outbox.js";
/** Validate caller labels, amounts and retry configuration before even reading a replay key. */
function validateCreation(args) {
    text(args.key, "KEY", LIMITS.maxKeyBytes);
    text(args.provider, "PROVIDER");
    for (const value of Object.values(args.attribution))
        if (value !== undefined)
            text(value, "ATTRIBUTION");
    if (args.profile)
        text(args.profile, "PROFILE");
    if (args.quantity !== undefined)
        integer(args.quantity, LIMITS.maxQuantity, "QUANTITY");
    if (args.credits !== undefined)
        integer(args.credits, LIMITS.maxQuantity, "CREDITS");
    if (args.nanos !== undefined)
        integer(args.nanos, args.reason === "OVER_CAP" ? LIMITS.maxBilledNanos : LIMITS.maxChargeNanos, "NANOS");
    integer(args.maxThreadCharges, LIMITS.maxThreadCharges, "THREAD_CHARGES");
    if (!args.maxThreadCharges)
        throw new Error("INVALID_THREAD_CHARGES");
    if (args.reason && args.status !== "unknown")
        throw new Error("INVALID_REASON");
    validateJobs(args.jobs);
    if (args.sinks.length > LIMITS.maxSinks || new Set(args.sinks).size !== args.sinks.length)
        throw new Error("INVALID_SINKS");
    for (const sink of args.sinks)
        text(sink, "SINK");
}
/** Keep a component-wide key bound to its original provider and attribution on replay. */
async function replayCreation(ctx, existing, args) {
    // The component-wide key is immutable. Replays return the latest charge,
    // but cannot move another subject's charge or attach a different provider.
    const names = new Set([...Object.keys(existing.attribution), ...Object.keys(args.attribution)]);
    if (existing.provider !== args.provider ||
        [...names].some((name) => existing.attribution[name] !==
            args.attribution[name]))
        throw new Error("KEY_CONFLICT");
    if (args.source === "estimate" &&
        (existing.status === "settled" || existing.status === "unknown"))
        await stale(ctx, existing, "estimate", 0);
}
/** Build the immutable charge identity, initial pricing and empty receipt/outbox state. */
function newCharge(args, enabledBreakdowns, full) {
    return {
        // Identity and frozen projection membership cannot change on replay.
        key: args.key,
        attribution: args.attribution,
        provider: args.provider,
        breakdowns: enabledBreakdowns,
        // Initial pricing retains known amounts even when capacity denies the gate.
        profile: args.profile,
        quantity: args.quantity,
        status: full ? "unknown" : args.status,
        source: args.source,
        nanos: args.nanos,
        credits: args.credits,
        reason: full ? "THREAD_CAPACITY" : args.reason,
        // No event or lifecycle operation exists until its first admission.
        sinkState: args.sinks.map((name) => ({ name, revision: 0 })),
        terminal: false,
        revision: 0,
        operations: [],
    };
}
/** Validate, replay or admit one charge, then update projections and outbox in order. */
export async function createCharge(ctx, args) {
    const enabledBreakdowns = resolveBreakdowns(args.breakdowns);
    validateCreation(args);
    const existing = await find(ctx, args.key);
    if (existing) {
        await replayCreation(ctx, existing, args);
        return null;
    }
    // No deployment-wide capacity: the only count read is this ROOT THREAD's
    // own trees (3 unbounded counts, root + <=5 children each on a lazy root).
    // It serializes charge creation within one root thread, never across
    // threads or subjects. Past the cap the charge is still recorded, as
    // `unknown`, so the budget gate denies instead of a swallowed error
    // admitting unmetered work.
    const root = rootOf(args.attribution);
    const full = root !== undefined && (await threadCount(ctx, root)) >= args.maxThreadCharges;
    const id = await ctx.db.insert("charges", newCharge(args, enabledBreakdowns, full));
    const row = (await ctx.db.get("charges", id));
    await updateAggregates(ctx, row);
    await prepareSinks(ctx, row, args.jobs);
    return null;
}
