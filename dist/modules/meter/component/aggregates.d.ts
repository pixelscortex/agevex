/**
 * Meter aggregate projections and bounded summary arithmetic.
 * Lifecycle mutations replace frozen per-charge contributions; reads summarize
 * one owned subject, run or root-thread namespace without scanning charges.
 * Projection depths also supply the conservative delete budget used by prune.
 */
import { DirectAggregate } from "@convex-dev/aggregate";
import type { Bounds } from "@convex-dev/aggregate";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
export type Key = [string, number | string];
export type Tree = DirectAggregate<{
    Key: Key;
    Id: string;
    Namespace: string[];
}>;
export declare const byThread: Tree;
export declare const bySubject: Tree;
export declare const groups: readonly ["estimate", "settled", "unknown"];
export type Group = (typeof groups)[number];
export type Axis = "agent" | "model" | "provider";
export declare const axes: Axis[];
/** The root thread owns every thread-scoped tree; rootless charges have none. */
export declare function rootOf(attribution: Doc<"charges">["attribution"]): string | undefined;
type Projection = {
    tree: Tree;
    key: Key;
    namespace: string[];
    depth: number;
};
/**
 * Every namespace is owned by ONE subject or ONE root thread; none is shared
 * across the deployment. Writes for different subjects therefore never touch
 * a common B-tree node, and no read sums the whole mount.
 *
 * Membership depends only on immutable fields (attribution, provider, frozen
 * breakdowns, creation reason) plus the status group, so a replacement always
 * finds the entry the previous state inserted at the same index.
 *
 * `depth` is the worst-case tree depth used by prune's transaction accounting:
 * thread-scoped trees are capped at maxThreadCharges entries (depth <=10 at
 * node size 4: depth 11 needs >=2*3^10-1 = 118,097 entries); subject- and
 * run-scoped trees use the design ceiling LIMITS.subjectTreeDepth.
 */
export declare function projections(row: Doc<"charges">): Projection[];
/**
 * Upstream btree.ts:56-138 (insert/delete/replace handlers) and 590-805
 * (deleteFromNode/mergeNodes): replace deletes and inserts atomically; calls
 * share our transaction. Node size 4 (min occupancy 2, branching >=3), with
 * UTF-8 bounded labels, keeps every node <=2 KiB including temporary split items.
 *
 * Per projection and level, a delete reads <=8 docs (node, deficient child,
 * tree size lookup, both siblings, grandchild, merge re-reads; plus the
 * predecessor descent) and writes <=4; an insert reads <=2 and writes <=3.
 * The emptiness probe below reads one path. So one projection replacement is
 * <=11*D+7 reads and <=7*D+4 writes. At the hard maximum, eight projections:
 * 3 thread-scoped at D=10 and 5 subject/run-scoped at D=24:
 *   reads  3*117 + 5*271 = 1,706 docs (<3.4 MiB at 2 KiB)
 *   writes 3*74  + 5*172 = 1,082 docs (<2.2 MiB)
 * plus the <=280 KiB charge (<=3 patches), <=4 outbox rows, the 3-count
 * thread-capacity read (<=21 docs) and <=4 Workpool admissions: well under
 * 16 MiB / 32k docs read and 16 MiB / 16k docs written. ONE charge per mutation.
 */
export declare function updateAggregates(ctx: MutationCtx, row: Doc<"charges">, old?: Doc<"charges">): Promise<void>;
/** Remove every contribution of a deleted charge (prune). */
export declare function deleteAggregates(ctx: MutationCtx, row: Doc<"charges">): Promise<void>;
/** Worst-case reads (docs) a prune of this row costs in the aggregate trees. */
export declare function deleteCost(row: Doc<"charges">): number;
/** Entries currently in this root thread's capped trees (all three groups). */
export declare function threadCount(ctx: QueryCtx, root: string): Promise<number>;
export type Summary = Awaited<ReturnType<typeof summary>>;
/** Read all three status sums and the unknown count for one owned namespace/range. */
export declare function summary(ctx: QueryCtx, tree: Tree, namespace: string[], bounds?: Bounds<Key, string>): Promise<{
    totalNanos: number;
    estimatedNanos: number;
    settledNanos: number;
    unknown: number;
    unknownNanos: number;
    usd: {
        estimated: number;
        settled: number;
    };
}>;
/** Combine the capped and overflow thread summaries without hiding unknown charges. */
export declare function combine(a: Summary, b: Summary): Summary;
export {};
