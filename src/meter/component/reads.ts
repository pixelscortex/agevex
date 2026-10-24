import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { byThread, bySubject, summary, groups, type Axis, type Key } from "./aggregates.js";
import { integer, text, LIMITS } from "../limits.js";

export const threadCost = query({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }) => {
    text(threadId, "THREAD");
    return await summary(ctx, byThread, ["cost"], { prefix: [threadId] });
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
