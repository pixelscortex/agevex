/**
 * Effect receipts behind `defineOnceTool`: the registered `begin`,
 * `complete` and `unknown` endpoints with their claim/lease protocol, plus
 * the `purge` chain for every expiring receipt.
 *
 * A paid or external effect claims its `(scope, key)` receipt with `begin`
 * (`beginEffect`: replay a recorded outcome, report a live claim, or hand out
 * a fresh fencing claim with a lease), then records `complete`
 * (`completeEffect`, only for the current claim inside its lease) or
 * `unknown`. Paid work is never retried automatically: an expired lease or a
 * transport error becomes `unknown`, never a fresh claim (unless the tool is
 * repeat-safe). An optional assignment fence ties the effect to the turn
 * that started it. Request/response receipts are written by turns/send.ts and
 * turns/approvals.ts. `purge` deletes expired receipts in bounded batches and
 * reschedules itself only while expiring receipts remain. Table: `receipts`;
 * reads `assignments`.
 */
import { getConvexSize, v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server.js";
import { LIMITS } from "../limits.js";
import { armPurge, findReceipt } from "./records.js";
import { internal } from "../_generated/api.js";
/** A receipt only carries its fencing token and lease while running; every
 * transition out of running spreads this to drop them, and a late holder's
 * claim then no longer matches anything. */
export const unclaimed = { claim: undefined, leaseUntil: undefined };
/** False when the call names an assignment whose turn it no longer owns. */
async function fenceHolds(ctx, fence) {
    if (!fence.assignmentId)
        return true;
    const row = await ctx.db.get("assignments", fence.assignmentId);
    return !!(row &&
        !row.cancelled &&
        row.turnStatus === "running" &&
        row.turnToken === fence.executionId &&
        row.cancellationEpoch === fence.cancellationEpoch);
}
/** Claim `(scope, key)` for one effect attempt, or report why not: a
 * recorded outcome to replay, a live claim, a fingerprint conflict, an
 * `unknown` outcome (never re-run unless `repeatSafe`), or a stale turn. */
async function beginEffect(ctx, args) {
    if (!(await fenceHolds(ctx, args)))
        return { status: "stale" };
    const row = await findReceipt(ctx, args.scope, args.key);
    if (row && row.fingerprint !== args.fingerprint)
        return { status: "conflict", code: "KEY_CONFLICT" };
    if (row?.status === "done" || row?.status === "failed")
        return { status: row.status, result: row.result ?? null };
    if (row?.status === "running" && row.leaseUntil > Date.now())
        return { status: "running" };
    if (row && !args.repeatSafe) {
        if (row.status === "running")
            await ctx.db.patch("receipts", row._id, { ...unclaimed, status: "unknown" });
        return { status: "unknown" };
    }
    const leaseMs = args.leaseMs ?? LIMITS.leaseMs;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0)
        throw new Error("INVALID_LEASE");
    const claim = crypto.randomUUID();
    const fields = {
        status: "running",
        claim,
        leaseUntil: Date.now() + leaseMs,
        expiresAt: Date.now() + Math.max(leaseMs, LIMITS.receiptRetentionMs),
    };
    if (row)
        await ctx.db.patch("receipts", row._id, fields);
    else {
        await armPurge(ctx);
        await ctx.db.insert("receipts", {
            kind: "effect",
            scope: args.scope,
            key: args.key,
            fingerprint: args.fingerprint,
            ...fields,
        });
    }
    return { status: "claimed", claim, leaseUntil: fields.leaseUntil };
}
/** Record the outcome of the current claim. A stale claim is ignored; a
 * claim whose lease already expired becomes `unknown` instead. */
async function completeEffect(ctx, args) {
    if (!(await fenceHolds(ctx, args)))
        return null;
    const row = await findReceipt(ctx, args.scope, args.key);
    // Lease expiry is an unknown outcome even if a late action subsequently
    // answers. A repeat-safe reclaim rotates the claim, fencing the old action.
    if (!row || row.claim !== args.claim || row.status !== "running")
        return null;
    if (row.leaseUntil <= Date.now()) {
        await ctx.db.patch("receipts", row._id, { ...unclaimed, status: "unknown" });
        return null;
    }
    if (getConvexSize(args.result) > LIMITS.receiptResultBytes)
        throw new Error("RESULT_TOO_LARGE");
    await ctx.db.patch("receipts", row._id, {
        ...unclaimed,
        status: args.failed ? "failed" : "done",
        result: args.result,
    });
    return null;
}
/** The optional turn fence every ledger call may carry. */
const fenceArgs = {
    assignmentId: v.optional(v.id("assignments")),
    executionId: v.optional(v.string()),
    cancellationEpoch: v.optional(v.number()),
};
/** Claim an effect, or replay/refuse it; see `beginEffect`. */
export const begin = mutation({
    args: {
        scope: v.string(),
        key: v.string(),
        fingerprint: v.string(),
        repeatSafe: v.optional(v.boolean()),
        leaseMs: v.optional(v.number()),
        ...fenceArgs,
    },
    handler: (ctx, args) => beginEffect(ctx, args),
});
/** Record the current claim's outcome (or `unknown` after its lease). */
export const complete = mutation({
    args: {
        scope: v.string(),
        key: v.string(),
        claim: v.string(),
        failed: v.optional(v.boolean()),
        result: v.any(),
        ...fenceArgs,
    },
    returns: v.null(),
    handler: (ctx, args) => completeEffect(ctx, args),
});
/** Bounded indexed TTL work: never scan the entire ledger in a mutation. */
export const purge = internalMutation({
    args: {},
    returns: v.null(),
    handler: async (ctx) => {
        const expired = await ctx.db
            .query("receipts")
            .withIndex("by_expiry", (q) => q.eq("kind", "effect").lte("expiresAt", Date.now()))
            .take(LIMITS.purgeBatch);
        for (const row of expired)
            await ctx.db.delete("receipts", row._id);
        if (await ctx.db
            .query("receipts")
            .withIndex("by_expiry", (q) => q.eq("kind", "effect"))
            .first())
            await ctx.scheduler.runAfter(expired.length === LIMITS.purgeBatch ? 0 : LIMITS.purgeIntervalMs, internal.receipts.effects.purge, {});
        return null;
    },
});
/** A transport failure may have happened after provider admission. Preserve an
 * honest unknown outcome and never make that receipt eligible for paid replay.
 * One indexed receipt read + one <=64 KiB patch, independent of journal size. */
export const unknown = mutation({
    args: {
        scope: v.string(),
        key: v.string(),
        claim: v.string(),
        ...fenceArgs,
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        if (!(await fenceHolds(ctx, args)))
            return null;
        const row = await findReceipt(ctx, args.scope, args.key);
        if (row?.status === "running" && row.claim === args.claim)
            await ctx.db.patch("receipts", row._id, { ...unclaimed, status: "unknown" });
        return null;
    },
});
