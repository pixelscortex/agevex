import { v } from "convex/values";
import { getConvexSize } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  internalMutation,
  mutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server.js";
import { LIMITS } from "./limits.js";
import type { Id } from "./_generated/dataModel.js";

export async function findReceipt(ctx: Pick<QueryCtx, "db">, scope: string, key: string) {
  return ctx.db
    .query("receipts")
    .withIndex("by_scope_key", (q) => q.eq("scope", scope).eq("key", key))
    .unique();
}

/** One purge chain per nonempty ledger, rather than one scheduled job per key. */
export async function armPurge(ctx: MutationCtx) {
  if (!(await ctx.db.query("receipts").withIndex("by_expiry").first()))
    await ctx.scheduler.runAfter(LIMITS.purgeIntervalMs, internal.ledger.purge, {});
}

export const begin = mutation({
  args: {
    scope: v.string(),
    key: v.string(),
    fingerprint: v.string(),
    repeatSafe: v.optional(v.boolean()),
    leaseMs: v.optional(v.number()),
    assignmentId: v.optional(v.id("assignments")),
    executionId: v.optional(v.string()),
    cancellationEpoch: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (
      args.assignmentId &&
      !(await owned(ctx, args.assignmentId, args.executionId, args.cancellationEpoch))
    )
      return { status: "stale" as const };
    const row = await findReceipt(ctx, args.scope, args.key);
    if (row && row.fingerprint !== args.fingerprint)
      return { status: "conflict" as const, code: "KEY_CONFLICT" as const };
    if (row?.status === "done" || row?.status === "failed")
      return { status: row.status, result: row.result ?? null };
    if (row?.status === "running" && row.leaseUntil > Date.now())
      return { status: "running" as const };
    if (row && !args.repeatSafe) {
      if (row.status === "running") await ctx.db.patch("receipts", row._id, { status: "unknown" });
      return { status: "unknown" as const };
    }
    const leaseMs = args.leaseMs ?? LIMITS.leaseMs;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("INVALID_LEASE");
    const claim = crypto.randomUUID();
    const fields = {
      status: "running" as const,
      claim,
      leaseUntil: Date.now() + leaseMs,
      expiresAt: Date.now() + Math.max(leaseMs, LIMITS.receiptRetentionMs),
    };
    if (row) await ctx.db.patch("receipts", row._id, fields);
    else {
      await armPurge(ctx);
      await ctx.db.insert("receipts", {
        scope: args.scope,
        key: args.key,
        fingerprint: args.fingerprint,
        ...fields,
      });
    }
    return { status: "claimed" as const, claim };
  },
});

async function owned(
  ctx: MutationCtx,
  id: Id<"assignments">,
  executionId?: string,
  epoch?: number,
) {
  const row = await ctx.db.get("assignments", id);
  return (
    row &&
    !row.cancelled &&
    row.turnStatus === "running" &&
    row.turnToken === executionId &&
    row.cancellationEpoch === epoch
  );
}

export const complete = mutation({
  args: {
    scope: v.string(),
    key: v.string(),
    claim: v.string(),
    failed: v.optional(v.boolean()),
    result: v.any(),
    assignmentId: v.optional(v.id("assignments")),
    executionId: v.optional(v.string()),
    cancellationEpoch: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      args.assignmentId &&
      !(await owned(ctx, args.assignmentId, args.executionId, args.cancellationEpoch))
    )
      return null;
    const row = await findReceipt(ctx, args.scope, args.key);
    // Lease expiry is an unknown outcome even if a late action subsequently
    // answers. A repeat-safe reclaim rotates the claim, fencing the old action.
    if (!row || row.claim !== args.claim || row.status !== "running") return null;
    if (row.leaseUntil <= Date.now()) {
      await ctx.db.patch("receipts", row._id, { status: "unknown" });
      return null;
    }
    if (getConvexSize(args.result) > LIMITS.receiptResultBytes) throw new Error("RESULT_TOO_LARGE");
    await ctx.db.patch("receipts", row._id, {
      status: args.failed ? "failed" : "done",
      result: args.result,
    });
    return null;
  },
});

/** Bounded indexed TTL work: never scan the entire ledger in a mutation. */
export const purge = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const expired = await ctx.db
      .query("receipts")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
      .take(LIMITS.purgeBatch);
    for (const row of expired) await ctx.db.delete("receipts", row._id);
    if (await ctx.db.query("receipts").withIndex("by_expiry").first())
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
    assignmentId: v.optional(v.id("assignments")),
    executionId: v.optional(v.string()),
    cancellationEpoch: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      args.assignmentId &&
      !(await owned(ctx, args.assignmentId, args.executionId, args.cancellationEpoch))
    )
      return null;
    const row = await findReceipt(ctx, args.scope, args.key);
    if (row?.status === "running" && row.claim === args.claim)
      await ctx.db.patch("receipts", row._id, { status: "unknown" });
    return null;
  },
});
