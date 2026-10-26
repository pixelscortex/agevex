import { internal } from "../_generated/api.js";
import { LIMITS } from "../limits.js";
/** The effect receipt for `(scope, key)`, or null. Attachments and proposals
 * share the table but never the scope/key index range. */
export async function findReceipt(ctx, scope, key) {
    const row = await ctx.db
        .query("receipts")
        .withIndex("by_scope_key", (q) => q.eq("scope", scope).eq("key", key))
        .unique();
    return row?.kind === "effect" ? row : null;
}
/** An effect that committed inside the caller's own transaction, so it enters
 * the ledger already `done` (no claim or lease): request acceptance and native
 * approval/answer saves. Callers bound `result` (<=64 KiB) and arm the purge. */
export function newDoneReceipt(fields) {
    return {
        kind: "effect",
        scope: fields.scope,
        key: fields.key,
        fingerprint: fields.fingerprint,
        status: "done",
        result: fields.result,
        expiresAt: Date.now() + LIMITS.receiptRetentionMs,
    };
}
/** One purge chain per nonempty effect ledger, rather than one scheduled job
 * per key. Ownership attestations never arm or prolong this scheduled chain.
 * Call BEFORE inserting the first effect receipt: an existing effect row
 * means a chain is already scheduled. */
export async function armPurge(ctx) {
    if (!(await ctx.db
        .query("receipts")
        .withIndex("by_expiry", (q) => q.eq("kind", "effect"))
        .first()))
        await ctx.scheduler.runAfter(LIMITS.purgeIntervalMs, internal.receipts.effects.purge, {});
}
