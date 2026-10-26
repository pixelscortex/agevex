/**
 * Meter aggregate projections and bounded summary arithmetic.
 * Lifecycle mutations replace frozen per-charge contributions; reads summarize
 * one owned subject, run or root-thread namespace without scanning charges.
 * Projection depths also supply the conservative delete budget used by prune.
 */
import { DirectAggregate } from "@convex-dev/aggregate";
import type { Bounds } from "@convex-dev/aggregate";
import { components } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { LIMITS } from "../shared/limits.js";
import { usageProjections } from "./usage-projections.js";

export type Key = [string, number | string];
export type Tree = DirectAggregate<{ Key: Key; Id: string; Namespace: string[] }>;
export const byThread: Tree = new DirectAggregate(components.costByThread);
export const bySubject: Tree = new DirectAggregate(components.costBySubject);
export const groups = ["estimate", "settled", "unknown"] as const;
export type Group = (typeof groups)[number];
export type Axis = "agent" | "model" | "provider";
export const axes: Axis[] = ["agent", "model", "provider"];

/** Select the stored aggregate bucket; missing evidence always contributes to unknown. */
function group(row: Pick<Doc<"charges">, "status" | "nanos" | "source">): Group {
  return row.status === "unknown" || row.nanos === undefined
    ? "unknown"
    : row.source === "estimate"
      ? "estimate"
      : "settled";
}

/** An over-cap amount is `unknown` (it denies the gate whatever its size) and
 * contributes at most maxChargeNanos, so every exact-sum bound still holds;
 * the full amount stays on the row for billing. */
function summand(row: Doc<"charges">) {
  return Math.min(row.nanos ?? 0, LIMITS.maxChargeNanos);
}

/** The root thread owns every thread-scoped tree; rootless charges have none. */
export function rootOf(attribution: Doc<"charges">["attribution"]) {
  return attribution.rootThreadId ?? attribution.threadId;
}

export type Projection = {
  tree: Tree;
  key: Key;
  namespace: string[];
  depth: number;
  value?: number;
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
export function projections(row: Doc<"charges">): Projection[] {
  const a = row.attribution;
  const state = group(row);
  const day = Math.floor(row._creationTime / LIMITS.dayMs);
  const root = rootOf(a);
  const thread = LIMITS.threadTreeDepth;
  const subject = LIMITS.subjectTreeDepth;

  const entries: Projection[] = [
    { tree: bySubject, key: ["", day], namespace: ["subject", a.subject, state], depth: subject },
  ];

  if (root !== undefined)
    entries.push({
      tree: byThread,
      key: [a.agent ?? "", day],
      // Over-capacity charges go to a count-only namespace that threadCost reads
      // without bounds (O(1) on a lazy root), keeping the paged trees capped.
      namespace: [row.reason === "THREAD_CAPACITY" ? "overflow" : "thread", root, state],
      depth: row.reason === "THREAD_CAPACITY" ? subject : thread,
    });

  if (a.runId)
    entries.push({
      tree: bySubject,
      key: ["", day],
      namespace: ["run", a.subject, a.runId, state],
      depth: subject,
    });

  for (const axis of axes) {
    if (!row.breakdowns.includes(`subject.${axis}`)) continue;

    entries.push({
      tree: bySubject,
      key: [axis === "provider" ? row.provider : (a[axis] ?? ""), day],
      namespace: ["axis", a.subject, axis, state],
      depth: subject,
    });
  }

  // Agent grouping is the thread tree's own leading key. Only model/provider
  // need extra projections; overflow charges stay out of the paged trees.
  if (root !== undefined && row.reason !== "THREAD_CAPACITY")
    for (const axis of ["model", "provider"] as const) {
      if (!row.breakdowns.includes(`thread.${axis}`)) continue;

      entries.push({
        tree: bySubject,
        key: [axis === "provider" ? row.provider : (a.model ?? ""), day],
        namespace: ["thread", root, axis, state],
        depth: thread,
      });
    }

  return [...entries, ...usageProjections(row, bySubject, state)];
}

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
 * <=11*D+7 reads and <=7*D+4 writes. At the hard maximum, thirteen projections:
 * 3 thread-scoped at D=10 and 10 subject/run/node-scoped at D=24:
 *   reads  3*117 + 10*271 = 3,061 docs (<6 MiB at 2 KiB)
 *   writes 3*74  + 10*172 = 1,942 docs (<3.8 MiB)
 * plus the <=280 KiB charge (<=3 patches), <=4 outbox rows, the 3-count
 * thread-capacity read (<=21 docs) and <=4 Workpool admissions: well under
 * 16 MiB / 32k docs read and 16 MiB / 16k docs written. ONE charge per mutation.
 */
export async function updateAggregates(
  ctx: MutationCtx,
  row: Doc<"charges">,
  old?: Doc<"charges">,
) {
  const entries = projections(row);
  const previous = old && projections(old);

  for (const [index, entry] of entries.entries()) {
    const next = {
      key: entry.key,
      namespace: entry.namespace,
      sumValue: entry.value ?? summand(row),
    };

    const before = previous?.[index];

    if (before?.namespace.join("\u0000") !== entry.namespace.join("\u0000")) {
      // Small nodes bound bytes on range reads, but an aggregate insert into a
      // missing namespace creates a 16-wide tree (btree.ts:56-63). Initialize
      // only an EMPTY namespace, under OCC in this transaction. `min` reads one
      // path; unlike a full count it does not read every child of the lazy
      // root, so it does not conflict with every other write to the namespace.
      if (!(await entry.tree.min(ctx, { namespace: entry.namespace })))
        await entry.tree.clear(ctx, {
          namespace: entry.namespace,
          maxNodeSize: LIMITS.aggregateNodeSize,
        });
    }

    if (before)
      await entry.tree.replace(
        ctx,
        { key: before.key, namespace: before.namespace, id: row._id },
        next,
      );
    else await entry.tree.insert(ctx, { ...next, id: row._id });
  }
}

/** Remove every contribution of a deleted charge (prune). */
export async function deleteAggregates(ctx: MutationCtx, row: Doc<"charges">) {
  for (const entry of projections(row))
    await entry.tree.delete(ctx, { key: entry.key, namespace: entry.namespace, id: row._id });
}

/** Worst-case reads (docs) a prune of this row costs in the aggregate trees. */
export function deleteCost(row: Doc<"charges">) {
  // <=8 reads per level plus the tree lookup, root check and handler entry.
  return projections(row).reduce((sum, entry) => sum + 8 * entry.depth + 4, 0);
}

/** Entries currently in this root thread's capped trees (all three groups). */
export async function threadCount(ctx: QueryCtx, root: string) {
  let count = 0;

  for (const state of groups)
    count += await byThread.count(ctx, { namespace: ["thread", root, state] });

  return count;
}

export type Summary = Awaited<ReturnType<typeof summary>>;
/** Read all three status sums and the unknown count for one owned namespace/range. */
export async function summary(
  ctx: QueryCtx,
  tree: Tree,
  namespace: string[],
  bounds?: Bounds<Key, string>,
) {
  const sums: number[] = [];

  for (const state of groups)
    sums.push(await tree.sum(ctx, { namespace: [...namespace, state], bounds }));

  const unknown = await tree.count(ctx, { namespace: [...namespace, "unknown"], bounds });

  return totals(sums[0], sums[1], sums[2], unknown);
}

/** Keep budget totals separate from unknown billed nanos when formatting aggregate reads. */
function totals(estimated: number, settled: number, unknownNanos: number, unknown: number) {
  return {
    totalNanos: estimated + settled,
    estimatedNanos: estimated,
    settledNanos: settled,
    unknown,
    unknownNanos,
    usd: { estimated: estimated / LIMITS.nanosPerUsd, settled: settled / LIMITS.nanosPerUsd },
  };
}

/** Combine the capped and overflow thread summaries without hiding unknown charges. */
export function combine(a: Summary, b: Summary): Summary {
  return totals(
    a.estimatedNanos + b.estimatedNanos,
    a.settledNanos + b.settledNanos,
    a.unknownNanos + b.unknownNanos,
    a.unknown + b.unknown,
  );
}
