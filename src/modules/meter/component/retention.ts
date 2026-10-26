/**
 * Host-driven pruning of terminal charges and their aggregate projections.
 * Each batch observes its own deletes and charges actual row bytes plus a
 * conservative tree-delete budget before proceeding. Cutoff validation keeps
 * pruning out of active budget windows; the caller repeats only while more.
 */
import { getDocumentSize } from "convex/values";
import type { MutationCtx } from "./_generated/server.js";
import type { PruneArgs } from "./charge_contracts.js";
import { LIMITS, integer } from "../shared/limits.js";
import { deleteAggregates, deleteCost } from "./aggregates.js";

/**
 * Host-driven retention. Deletes settled charges whose sinks all acknowledged
 * (index by_terminal, no scan of live rows) created before `before`, with
 * their aggregate entries, so remaining totals stay exact. No rescheduling:
 * the host calls it again while `more`.
 *
 * Transaction bound: each candidate is charged its real size (getDocumentSize,
 * <=280 KiB with receipts) plus the worst-case aggregate delete cost of its
 * projections (aggregates.ts deleteCost: 8*D+4 docs each, D=10 thread-scoped,
 * D=24 subject/run-scoped, 2 KiB per node). The batch stops before 16k docs /
 * 12 MiB of reads; writes are at most half the node reads (4*D+2 per
 * projection) plus each deleted row, so also <=12 MiB / 8k docs. A default
 * charge (3 projections: 84 + 196 + 196) costs <=476 nodes (952 KiB): >=9 per
 * call with full 280-KiB receipt ledgers, >=12 with small rows; a fully
 * opted-in one (8: 3*84 + 5*196) <=1,232 nodes (2.4 MiB): >=4. `limit` caps the count.
 */
export async function pruneCharges(
  ctx: MutationCtx,
  { before, limit = LIMITS.pruneLimit, minAgeMs }: PruneArgs,
): Promise<{ deleted: number; more: boolean }> {
  integer(before, LIMITS.maxTimestamp, "BEFORE");
  integer(minAgeMs, LIMITS.pruneMinAgeMs, "MIN_AGE");

  // Guard: pruning lowers run and subject totals, so a cutoff inside an
  // active run or budget window would re-admit spend. Hosts may lower it.
  if (before > Date.now() - minAgeMs) throw new Error("PRUNE_TOO_RECENT");

  integer(limit, LIMITS.maxPruneLimit, "LIMIT");

  if (!limit) throw new Error("INVALID_LIMIT");

  let deleted = 0;
  let docs = 0;
  let bytes = 0;

  while (true) {
    // Re-query after each delete: reads observe this transaction's deletes,
    // so the next eligible row is always the first one. <=501 index queries.
    const row = await ctx.db
      .query("charges")
      .withIndex("by_terminal", (q) => q.eq("terminal", true).lt("_creationTime", before))
      .first();

    if (!row) return { deleted, more: false };

    const nodes = deleteCost(row);
    const cost = getDocumentSize(row) + nodes * LIMITS.nodeBytes;

    if (
      deleted === limit ||
      docs + nodes + 1 > LIMITS.pruneReadDocs ||
      bytes + cost > LIMITS.pruneReadBytes
    )
      return { deleted, more: true };

    docs += nodes + 1;
    bytes += cost;
    await deleteAggregates(ctx, row);
    await ctx.db.delete("charges", row._id);
    deleted++;
  }
}
