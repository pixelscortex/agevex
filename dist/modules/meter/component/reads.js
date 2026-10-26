/**
 * Registered meter aggregate queries used by authorized host read wrappers.
 * Thread pages and subject breakdowns seek bounded label groups in trees;
 * they never scan charge rows. Optional projections must be enabled explicitly.
 * Budget arithmetic beside each read explains the hard-maximum transaction bound.
 */
import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { byThread, bySubject, combine, summary, groups, } from "./aggregates.js";
import { integer, text, LIMITS } from "../shared/limits.js";
import { requireBreakdown, resolveBreakdowns } from "../shared/breakdowns.js";
import { breakdowns } from "./schema.js";
/** Seek one next label per status, then aggregate the complete label prefix.
 * Thread trees are capped at maxThreadCharges entries: depth D<=10.
 * min/pageSize=1 follows <=two boundary paths plus one result path, <=3D=30
 * nodes (aggregate client:404-418, btree:1158-1231); range sums visit <=8D=80
 * nodes (btree:333-415). At maxGroups=4, each axis costs <=15*30 + 16*80=1730
 * node reads. All keys have two fields and nodes <=2 KiB, so three pages use
 * 3*1730*2 KiB =10.14 MiB. Totals read the thread and overflow namespaces
 * WITHOUT bounds: on a lazy root that is the root plus <=5 children per call,
 * 8 calls * 7 docs. Tree/index metadata adds <0.5 MiB; <6k docs, <256 index
 * queries, zero writes. No charge scans; every axis has its own cursor.
 */
async function threadPage(ctx, root, axis, maxGroups, cursor) {
    const tree = axis === "agent" ? byThread : bySubject;
    const namespace = axis === "agent" ? ["thread", root] : ["thread", root, axis];
    let after = cursor;
    const page = [];
    for (let index = 0; index <= maxGroups; index++) {
        const labels = [];
        for (const state of groups) {
            const item = await tree.min(ctx, {
                namespace: [...namespace, state],
                // Day ordinals are numbers, which Convex sorts before every string,
                // so [after, maxTimestamp] exclusively skips all of `after`'s entries.
                bounds: after === undefined
                    ? undefined
                    : { lower: { key: [after, LIMITS.maxTimestamp], inclusive: false } },
            });
            if (item)
                labels.push(item.key[0]);
        }
        labels.sort();
        const label = labels[0];
        if (label === undefined)
            return { page, cursor: null };
        if (index === maxGroups)
            return { page, cursor: after ?? null };
        page.push({ key: label, ...(await summary(ctx, tree, namespace, { prefix: [label] })) });
        after = label;
    }
    return { page, cursor: null };
}
/** Summarize a root thread and page its enabled axes under the capped-tree read budget. */
export const threadCost = query({
    args: {
        threadId: v.string(),
        breakdowns,
        maxGroups: v.number(),
        cursors: v.optional(v.object({
            agent: v.optional(v.string()),
            model: v.optional(v.string()),
            provider: v.optional(v.string()),
        })),
    },
    handler: async (ctx, { threadId, maxGroups, cursors, breakdowns }) => {
        const enabled = resolveBreakdowns(breakdowns);
        text(threadId, "THREAD");
        integer(maxGroups, LIMITS.maxGroups, "GROUPS");
        if (!maxGroups)
            throw new Error("INVALID_GROUPS");
        // Empty labels are valid cursors for missing attribution, unlike user labels.
        for (const cursor of Object.values(cursors ?? {}))
            if (cursor !== undefined && cursor !== "")
                text(cursor, "CURSOR");
        for (const axis of ["model", "provider"])
            if (cursors?.[axis] !== undefined)
                requireBreakdown(enabled, `thread.${axis}`);
        return {
            // Over-capacity charges are counted here (never zero), not in the pages.
            ...combine(await summary(ctx, byThread, ["thread", threadId]), await summary(ctx, byThread, ["overflow", threadId])),
            byAgent: await threadPage(ctx, threadId, "agent", maxGroups, cursors?.agent),
            ...(enabled.includes("thread.model")
                ? { byModel: await threadPage(ctx, threadId, "model", maxGroups, cursors?.model) }
                : {}),
            ...(enabled.includes("thread.provider")
                ? { byProvider: await threadPage(ctx, threadId, "provider", maxGroups, cursors?.provider) }
                : {}),
        };
    },
});
/** Read a single subject/run aggregate snapshot for host reporting and budget admission. */
export const cost = query({
    args: { subject: v.string(), runId: v.optional(v.string()) },
    handler: async (ctx, { subject, runId }) => {
        text(subject, "SUBJECT");
        if (runId)
            text(runId, "RUN");
        // Both are unbounded reads of ONE owned namespace: on a lazy root that is
        // the root plus <=5 children per call, independent of how many charges exist.
        return runId
            ? await summary(ctx, bySubject, ["run", subject, runId])
            : await summary(ctx, bySubject, ["subject", subject]);
    },
});
/** Page an enabled subject axis or a bounded UTC-day range without reading charge rows. */
export const breakdown = query({
    args: {
        breakdowns,
        subject: v.string(),
        from: v.number(),
        to: v.number(),
        by: v.union(v.literal("day"), v.literal("agent"), v.literal("model"), v.literal("provider")),
        cursor: v.optional(v.string()),
        maxGroups: v.number(),
        maxDays: v.number(),
    },
    handler: async (ctx, args) => {
        const enabled = resolveBreakdowns(args.breakdowns);
        if (args.by !== "day")
            requireBreakdown(enabled, `subject.${args.by}`);
        text(args.subject, "SUBJECT");
        integer(args.from, LIMITS.maxTimestamp, "FROM");
        integer(args.to, LIMITS.maxTimestamp, "TO");
        integer(args.maxGroups, LIMITS.maxGroups, "GROUPS");
        integer(args.maxDays, LIMITS.maxDays, "DAYS");
        if (!args.maxGroups || !args.maxDays || args.to <= args.from)
            throw new Error("INVALID_RANGE");
        const from = Math.floor(args.from / LIMITS.dayMs);
        const to = Math.ceil(args.to / LIMITS.dayMs);
        // Day granularity is explicit: silently widening a timestamp range would bill
        // events the caller did not ask for. Both endpoints must be UTC midnight.
        if (args.from % LIMITS.dayMs || args.to % LIMITS.dayMs)
            throw new Error("DAY_BOUNDARIES_REQUIRED");
        if (args.cursor)
            text(args.cursor, "CURSOR");
        const page = [];
        if (args.by === "day") {
            if (to - from > args.maxDays)
                throw new Error("RANGE_TOO_LARGE");
            for (let day = from; day < to; day++) {
                page.push({
                    key: String(day),
                    ...(await summary(ctx, bySubject, ["subject", args.subject], { eq: ["", day] })),
                });
            }
            return { page, cursor: null };
        }
        const axis = args.by;
        let after = args.cursor;
        // At the hard maximum: 4 groups * (3 seeks + 4 summary reads), plus
        // 3 final seeks =31 aggregate queries. Subject trees are not count-capped;
        // at the design depth D=24 (LIMITS.subjectTreeDepth) upstream
        // btree.ts:333-415 visits <=2 boundary paths plus <=4 siblings per level:
        // <=8*24=192 nodes, <=2 KiB each. Thus <=5952 docs / 11.63 MiB; helper and
        // index overhead stays below 4096 queries / 16 MiB. Day reads use keys
        // ["", day] (<=1 KiB nodes): 7*4*192*1 KiB =5.25 MiB.
        // No charge scan, no offset
        // pagination, and a cursor lets hosts enumerate arbitrary cardinalities.
        for (let index = 0; index <= args.maxGroups; index++) {
            const labels = [];
            for (const state of groups) {
                const item = await bySubject.min(ctx, {
                    namespace: ["axis", args.subject, axis, state],
                    bounds: after === undefined
                        ? undefined
                        : {
                            lower: { key: [after, LIMITS.maxTimestamp], inclusive: false },
                        },
                });
                if (item)
                    labels.push(item.key[0]);
            }
            labels.sort();
            const label = labels[0];
            if (label === undefined)
                return { page, cursor: null };
            if (index === args.maxGroups)
                return { page, cursor: after ?? null };
            page.push({
                key: label,
                ...(await summary(ctx, bySubject, ["axis", args.subject, axis], {
                    lower: { key: [label, from], inclusive: true },
                    upper: { key: [label, to], inclusive: false },
                })),
            });
            after = label;
        }
        return { page, cursor: null };
    },
});
