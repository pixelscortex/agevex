import { LIMITS, integer } from "../shared/limits.js";
import { find, stale, replay, remember } from "./charge-records.js";
import { validateJobs } from "./jobs.js";
import { updateAggregates } from "./aggregates.js";
import { prepareSinks } from "./outbox.js";
/** Advance only amount/state revisions, updating projections before preparing sink events. */
export async function change(ctx, row, patch, config) {
    // Only amount/state transitions advance the outcome revision. Attachment and
    // sink acknowledgements do not change the amount represented by that revision.
    patch = { ...patch, revision: row.revision + 1 };
    if (patch.source === "lookup" || patch.source === "settlement")
        patch.reconciliation = "complete";
    const next = { ...row, ...patch };
    await ctx.db.patch("charges", row._id, patch);
    if (row.nanos !== next.nanos || row.status !== next.status || row.source !== next.source)
        await updateAggregates(ctx, next, row);
    return await prepareSinks(ctx, next, config);
}
/** Replay a stable operation or apply the same settlement/correction precedence fences. */
export async function updateCharge(ctx, args) {
    validateJobs(args.jobs);
    integer(args.nanos, LIMITS.maxBilledNanos, "NANOS");
    // Above the per-charge cap the amount is kept but becomes unknown, exactly
    // as at creation: recording never throws on an unpriceable business amount.
    const over = args.nanos > LIMITS.maxChargeNanos;
    if (args.quantity !== undefined)
        integer(args.quantity, LIMITS.maxQuantity, "QUANTITY");
    if (args.credits !== undefined)
        integer(args.credits, LIMITS.maxQuantity, "CREDITS");
    const row = await find(ctx, args.key);
    if (!row)
        throw new Error("CHARGE_NOT_FOUND");
    const previous = replay(row, args.operationKey);
    if (previous)
        return previous;
    const save = (next) => remember(ctx, next, args.operationKey);
    // Authoritative results always outrank estimates, including concurrent
    // corrections. Settled amounts are immutable even for another settlement.
    if (row.status === "settled" &&
        args.operation === "settle" &&
        row.nanos === args.nanos &&
        row.credits === args.credits)
        return await save(row);
    if (row.status === "settled")
        return await save(await stale(ctx, row, args.operation, row.revision));
    if (args.operation === "correct") {
        if (row.status === "unknown")
            return await save(await stale(ctx, row, args.operation, row.revision));
        if (row.nanos === args.nanos && row.quantity === args.quantity && row.status === "corrected")
            return await save(row);
    }
    return await save(await change(ctx, row, {
        nanos: args.nanos,
        quantity: args.quantity ?? row.quantity,
        credits: args.credits ?? row.credits,
        status: over || row.reason === "THREAD_CAPACITY"
            ? "unknown"
            : args.operation === "correct"
                ? "corrected"
                : "settled",
        source: args.operation === "correct" ? "estimate" : "settlement",
        // THREAD_CAPACITY routes projections and must never change.
        ...(over && row.reason !== "THREAD_CAPACITY" ? { reason: "OVER_CAP" } : {}),
    }, args.jobs));
}
