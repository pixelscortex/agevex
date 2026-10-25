/**
 * Registered endpoints of the effect ledger behind `defineOnceTool`, plus the
 * purge chain for every expiring receipt.
 *
 * A paid or external effect claims its `(scope, key)` receipt with `begin`
 * (a fencing claim plus lease), then records `complete` or `unknown`. Paid
 * work is never retried automatically: an expired lease or a transport error
 * becomes `unknown`, never a fresh claim (unless the tool is repeat-safe).
 * The protocol lives in receipts/claims.ts; lookups, row builders and purge
 * arming in receipts/records.ts. `purge` deletes expired receipts in bounded
 * batches and reschedules itself only while expiring receipts remain.
 * Table: `receipts`.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation } from "./_generated/server.js";
import { LIMITS } from "./limits.js";
import { findReceipt } from "./receipts/records.js";
import { beginEffect, completeEffect, fenceHolds, unclaimed } from "./receipts/claims.js";

/** The optional turn fence every ledger call may carry. */
const fenceArgs = {
  assignmentId: v.optional(v.id("assignments")),
  executionId: v.optional(v.string()),
  cancellationEpoch: v.optional(v.number()),
};

/** Claim an effect, or replay/refuse it; see receipts/claims.ts. */
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
    for (const row of expired) await ctx.db.delete("receipts", row._id);

    if (
      await ctx.db
        .query("receipts")
        .withIndex("by_expiry", (q) => q.eq("kind", "effect"))
        .first()
    )
      await ctx.scheduler.runAfter(
        expired.length === LIMITS.purgeBatch ? 0 : LIMITS.purgeIntervalMs,
        internal.ledger.purge,
        {},
      );
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
    if (!(await fenceHolds(ctx, args))) return null;

    const row = await findReceipt(ctx, args.scope, args.key);
    if (row?.status === "running" && row.claim === args.claim)
      await ctx.db.patch("receipts", row._id, { ...unclaimed, status: "unknown" });
    return null;
  },
});
