import type { MutationCtx } from "./_generated/server.js";
import type { PruneArgs } from "./charge-contracts.js";
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
export declare function pruneCharges(ctx: MutationCtx, { before, limit, minAgeMs }: PruneArgs): Promise<{
    deleted: number;
    more: boolean;
}>;
