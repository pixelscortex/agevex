import { DirectAggregate } from "@convex-dev/aggregate";
import type { Bounds } from "@convex-dev/aggregate";
import { components } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { LIMITS } from "../limits.js";

export type Key = [string, number] | [string, string, string];
type Tree = DirectAggregate<{ Key: Key; Id: string; Namespace: string[] }>;
export const byThread: Tree = new DirectAggregate(components.costByThread);
export const bySubject: Tree = new DirectAggregate(components.costBySubject);
export const groups = ["estimate", "settled", "unknown"] as const;
export type Group = (typeof groups)[number];
export type Axis = "agent" | "model" | "provider";
export const axes: Axis[] = ["agent", "model", "provider"];

function group(row: Doc<"charges">): Group {
  return row.status === "unknown" || row.nanos === undefined
    ? "unknown"
    : row.source === "estimate"
      ? "estimate"
      : "settled";
}

function projections(row: Doc<"charges">) {
  const a = row.attribution;
  const state = group(row);
  const day = Math.floor(row._creationTime / LIMITS.dayMs);
  const entries: { tree: Tree; key: Key; namespace: string[] }[] = [
    {
      tree: byThread,
      key: [a.rootThreadId ?? a.threadId ?? "", a.agent ?? "", a.model ?? ""],
      namespace: ["cost", state],
    },
    { tree: bySubject, key: [a.subject, day], namespace: ["cost", state] },
  ];
  if (a.runId)
    entries.push({
      tree: bySubject,
      key: ["", day],
      namespace: ["run", a.subject, a.runId, state],
    });
  for (const axis of axes)
    entries.push({
      tree: bySubject,
      key: [axis === "provider" ? row.provider : (a[axis] ?? ""), day],
      namespace: ["axis", a.subject, axis, state],
    });
  return entries;
}

/**
 * Upstream src/client/index.ts:866-915 and component/btree.ts:120-138:
 * replace atomically deletes and inserts; synchronous calls share our transaction.
 * We cap the WHOLE mount at 100k charges, making each tree <=100k entries.
 * Node size 4 (min occupancy 2, branching >=3) needs <=12 levels. UTF-8 bounds
 * keep a thread node <=4 KiB and subject node <=2 KiB, including temporary
 * split items. At most 6 projections per charge: the usual default-size
 * replace ~=12 writes becomes a conservative 2*12*4=96 split/merge operations
 * per projection, <=576 total. Allowing namespace initialization and helpers:
 * <2048 reads/queries (<8 MiB) and <1024 writes (<4 MiB), plus the <=8-KiB
 * charge and four Workpool admissions. ONE charge per mutation only.
 * The brief's two replacements cannot provide non-leading axis/run queries;
 * namespaces add projections without adding mounts or owned tables.
 */
export async function updateAggregates(
  ctx: MutationCtx,
  row: Doc<"charges">,
  old?: Doc<"charges">,
) {
  const entries = projections(row);
  const previous = old && projections(old);
  for (const [index, entry] of entries.entries()) {
    const next = { key: entry.key, namespace: entry.namespace, sumValue: row.nanos ?? 0 };
    // Small, eagerly aggregated nodes bound bytes on range reads; default-size
    // lazy roots can visit many large siblings. clear() is used ONLY on an
    // empty namespace, under OCC in this transaction, never on live data.
    if ((await entry.tree.count(ctx, { namespace: entry.namespace })) === 0)
      await entry.tree.clear(ctx, {
        namespace: entry.namespace,
        maxNodeSize: LIMITS.aggregateNodeSize,
        rootLazy: false,
      });
    if (previous) {
      const before = previous[index];
      await entry.tree.replace(
        ctx,
        { key: before.key, namespace: before.namespace, id: row._id },
        next,
      );
    } else await entry.tree.insert(ctx, { ...next, id: row._id });
  }
}

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
  return {
    totalNanos: sums[0] + sums[1],
    estimatedNanos: sums[0],
    settledNanos: sums[1],
    unknown,
    unknownNanos: sums[2],
    usd: { estimated: sums[0] / LIMITS.nanosPerUsd, settled: sums[1] / LIMITS.nanosPerUsd },
  };
}

export async function chargeCount(ctx: QueryCtx) {
  let count = 0;
  for (const state of groups) count += await bySubject.count(ctx, { namespace: ["cost", state] });
  return count;
}
