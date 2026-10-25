import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server.js";
import {
  byThread,
  bySubject,
  summary,
  groups,
  type Axis,
  type Key,
  type Tree,
} from "./aggregates.js";
import { integer, text, LIMITS } from "../limits.js";

/** Seek one next label per status, then aggregate the complete label prefix.
 * min/pageSize=1 follows <=two boundary paths plus one result path, <=36
 * nodes (aggregate client:404-418, btree:1158-1231); range sums visit <=96
 * nodes (btree:333-415). At maxGroups=4, each axis costs <=15*36 + 16*96=2076
 * node reads. All keys have two fields and nodes <=2 KiB, so three pages plus
 * totals use (3*2076 + 4*96)*2 KiB =12.92 MiB.
 * Tree/index/worker metadata adds <0.5 MiB; <7k docs, <256 index queries, zero
 * writes. No charge scans; every axis has its own continuation cursor.
 */
async function threadPage(
  ctx: QueryCtx,
  root: string,
  axis: Axis,
  maxGroups: number,
  cursor?: string,
) {
  const tree: Tree = axis === "agent" ? byThread : bySubject;
  const namespace = axis === "agent" ? ["cost"] : ["thread", root, axis];
  let after = cursor;
  const page = [];
  for (let index = 0; index <= maxGroups; index++) {
    const labels: string[] = [];
    for (const state of groups) {
      const item = await tree.min(ctx, {
        namespace: [...namespace, state],
        bounds:
          axis === "agent"
            ? {
                // Convex arrays sort after every string; the upper sentinel
                // includes exactly this root. An exclusive tuple skips all ids
                // for the previous agent without reading any charge documents.
                lower: {
                  key: (after === undefined ? [root] : [root, after]) as unknown as Key,
                  inclusive: false,
                },
                upper: { key: [root, []] as unknown as Key, inclusive: false },
              }
            : after === undefined
              ? undefined
              : { lower: { key: [after, LIMITS.maxTimestamp], inclusive: false } },
      });
      if (item) labels.push(item.key[axis === "agent" ? 1 : 0] as string);
    }
    labels.sort();
    const label = labels[0];
    if (label === undefined) return { page, cursor: null as string | null };
    if (index === maxGroups) return { page, cursor: after ?? null };
    page.push({
      key: label,
      ...(await summary(ctx, tree, namespace, {
        prefix: axis === "agent" ? [root, label] : [label],
      })),
    });
    after = label;
  }
  return { page, cursor: null as string | null };
}

export const threadCost = query({
  args: {
    threadId: v.string(),
    maxGroups: v.number(),
    cursors: v.optional(
      v.object({
        agent: v.optional(v.string()),
        model: v.optional(v.string()),
        provider: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { threadId, maxGroups, cursors }) => {
    text(threadId, "THREAD");
    integer(maxGroups, LIMITS.maxGroups, "GROUPS");
    if (!maxGroups) throw new Error("INVALID_GROUPS");
    // Empty labels are valid cursors for missing attribution, unlike user labels.
    for (const cursor of Object.values(cursors ?? {}))
      if (cursor !== undefined && cursor !== "") text(cursor, "CURSOR");
    return {
      ...(await summary(ctx, byThread, ["cost"], { prefix: [threadId] })),
      byAgent: await threadPage(ctx, threadId, "agent", maxGroups, cursors?.agent),
      byModel: await threadPage(ctx, threadId, "model", maxGroups, cursors?.model),
      byProvider: await threadPage(ctx, threadId, "provider", maxGroups, cursors?.provider),
    };
  },
});

export const cost = query({
  args: { subject: v.string(), runId: v.optional(v.string()) },
  handler: async (ctx, { subject, runId }) => {
    text(subject, "SUBJECT");
    if (runId) text(runId, "RUN");
    return runId
      ? await summary(ctx, bySubject, ["run", subject, runId])
      : await summary(ctx, bySubject, ["cost"], { prefix: [subject] });
  },
});

export const breakdown = query({
  args: {
    subject: v.string(),
    from: v.number(),
    to: v.number(),
    by: v.union(v.literal("day"), v.literal("agent"), v.literal("model"), v.literal("provider")),
    cursor: v.optional(v.string()),
    maxGroups: v.number(),
    maxDays: v.number(),
  },
  handler: async (ctx, args) => {
    text(args.subject, "SUBJECT");
    integer(args.from, LIMITS.maxTimestamp, "FROM");
    integer(args.to, LIMITS.maxTimestamp, "TO");
    integer(args.maxGroups, LIMITS.maxGroups, "GROUPS");
    integer(args.maxDays, LIMITS.maxDays, "DAYS");
    if (!args.maxGroups || !args.maxDays || args.to <= args.from) throw new Error("INVALID_RANGE");
    const from = Math.floor(args.from / LIMITS.dayMs);
    const to = Math.ceil(args.to / LIMITS.dayMs);
    // Day granularity is explicit: silently widening a timestamp range would bill
    // events the caller did not ask for. Both endpoints must be UTC midnight.
    if (args.from % LIMITS.dayMs || args.to % LIMITS.dayMs)
      throw new Error("DAY_BOUNDARIES_REQUIRED");
    if (args.cursor) text(args.cursor, "CURSOR");
    const page = [];
    if (args.by === "day") {
      if (to - from > args.maxDays) throw new Error("RANGE_TOO_LARGE");
      for (let day = from; day < to; day++) {
        page.push({
          key: String(day),
          ...(await summary(ctx, bySubject, ["cost"], {
            eq: [args.subject, day],
          })),
        });
      }
      return { page, cursor: null as string | null };
    }
    const axis: Axis = args.by;
    let after = args.cursor;
    // At the hard maximum: 4 groups * (3 seeks + 4 summary reads), plus
    // 3 final seeks =31 aggregate queries. Upstream btree.ts:333-415 visits
    // <=2 boundary paths plus <=4 siblings per level: <=2*12*4=96 nodes,
    // <=2 KiB each. Thus <=2976 docs / 5.82 MiB; helper/index overhead stays
    // below 4096 queries / 16 MiB. Day reads: 7*4*96*2 KiB =5.25 MiB.
    // No charge scan, no offset
    // pagination, and a cursor lets hosts enumerate arbitrary cardinalities.
    for (let index = 0; index <= args.maxGroups; index++) {
      const labels: string[] = [];
      for (const state of groups) {
        const item = await bySubject.min(ctx, {
          namespace: ["axis", args.subject, axis, state],
          bounds:
            after === undefined
              ? undefined
              : {
                  lower: { key: [after, LIMITS.maxTimestamp] as Key, inclusive: false },
                },
        });
        if (item) labels.push(item.key[0]);
      }
      labels.sort();
      const label = labels[0];
      if (label === undefined) return { page, cursor: null as string | null };
      if (index === args.maxGroups) return { page, cursor: after ?? null };
      page.push({
        key: label,
        ...(await summary(ctx, bySubject, ["axis", args.subject, axis], {
          lower: { key: [label, from], inclusive: true },
          upper: { key: [label, to], inclusive: false },
        })),
      });
      after = label;
    }
    return { page, cursor: null as string | null };
  },
});
