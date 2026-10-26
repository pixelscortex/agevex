import { LIMITS, text, chargeKey } from "../shared/limits.js";
/** Load one validated immutable key; used before every charge lifecycle operation. */
export async function find(ctx, key) {
    chargeKey(key);
    return await ctx.db
        .query("charges")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
}
/** Authoritative and corrected amounts can be billed; estimates still await evidence. */
function final(row) {
    return row.status === "settled" || row.status === "corrected";
}
/**
 * Billing is separate from budgeting. A known cost (inline, settlement or
 * lookup) that is `unknown` only because it overflowed its thread or exceeded
 * the per-charge cap is still delivered to sinks: it is unknown for the gate,
 * billed because the amount is known. Estimates are billed once corrected.
 */
export function billable(row) {
    return (row.nanos !== undefined &&
        (final(row) || (row.status === "unknown" && row.source !== "estimate")));
}
/** Missing inline evidence can be recovered by lookup too; expiry never restarts itself. */
export function resolved(row) {
    return row.reconciliation === "complete" || row.reconciliation === "exhausted";
}
/** Settled and acknowledged by every sink (vacuously true without sinks).
 * `corrected` is not terminal: a settlement or lookup may still replace it. */
export function isTerminal(row) {
    return (row.status === "settled" &&
        row.nanos !== undefined &&
        row.sinkState.every((sink) => !sink.pending && sink.deliveredNanos === row.nanos));
}
/** Record a rejected state transition once without advancing the amount revision. */
export async function stale(ctx, row, operation, revision) {
    if (row.lastStale?.operation === operation && row.lastStale.revision === revision)
        return row;
    const lastStale = { operation, revision };
    await ctx.db.patch("charges", row._id, { lastStale });
    return { ...row, lastStale };
}
/** Caller-facing charge: retry state is joined from the <=4 outbox rows (one
 * bounded index read), so failures never have to rewrite the large charge row. */
export async function outcome(ctx, row) {
    const { operations: _operations, terminal: _terminal, ...result } = row;
    const pending = await ctx.db
        .query("deliveries")
        .withIndex("by_key", (q) => q.eq("key", row.key))
        .take(LIMITS.maxSinks);
    return {
        ...result,
        reconciliation: result.reconciliation ?? "unavailable",
        sinkState: row.sinkState.map((sink) => {
            const delivery = pending.find((entry) => entry.sink === sink.name);
            return { ...sink, attempts: delivery?.attempts ?? 0, failed: delivery?.failed ?? false };
        }),
    };
}
/** Return the immutable operation result, or fail closed before the receipt ledger fills. */
export function replay(row, key) {
    text(key, "OPERATION_KEY", LIMITS.maxKeyBytes);
    const receipt = row.operations.find((entry) => entry.key === key);
    if (receipt)
        return receipt.outcome;
    // Never evict a receipt: a delayed replay of an evicted key would become a
    // new correction and could raise an estimate again. At 32 distinct keys the
    // charge fails closed for new operations, while every old key stays replayable.
    // Each outcome is <8 KiB (bounded fields/four sinks, no nested ledger):
    // 32 * (8 KiB + 256-byte key + 128-byte wrapper) + 8 KiB = 276 KiB < 1 MiB.
    // One charge per transaction adds <280 KiB read and <840 KiB for at most
    // three row patches to the aggregate budget (aggregates.ts).
    if (row.operations.length >= LIMITS.maxOperations)
        throw new Error("OPERATION_CAPACITY");
}
/** Snapshot the bounded caller view after all writes, then store this operation receipt. */
export async function remember(ctx, row, key) {
    const result = await outcome(ctx, row);
    await ctx.db.patch("charges", row._id, {
        operations: [...row.operations, { key, outcome: result }],
    });
    return result;
}
