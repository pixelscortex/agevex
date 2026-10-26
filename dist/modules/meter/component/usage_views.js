/** Bounded reactive usage views for host queries and the optional core slot.
 * One owned run plus <=59 known nodes; no charge or transcript discovery.
 */
import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { LIMITS, text } from "../shared/limits.js";
export const usageViewArgs = {
    subject: v.string(),
    runId: v.string(),
    nodeIds: v.array(v.union(v.string(), v.null())),
    partial: v.optional(v.boolean()),
};
export const usageView = v.object({
    inputTokens: v.union(v.number(), v.null()),
    outputTokens: v.union(v.number(), v.null()),
    estimatedUsd: v.number(),
    settledUsd: v.number(),
    unknown: v.number(),
    reporting: v.union(v.literal("available"), v.literal("partial")),
});
export const usageProjection = v.object({
    total: usageView,
    nodes: v.array(v.object({ nodeId: v.union(v.string(), v.null()), usage: usageView })),
});
/** Complete namespaces read <=7 docs per aggregate operation (lazy root and
 * <=5 children plus metadata). 60*6*7 <=2520 docs /5040 KiB at <=2 KiB/node;
 * pending-operation probes add <=60 docs /120 KiB. Combined with core's
 * 2373 KiB tree metadata: <=7533 KiB <8 MiB. Output <=60*512 bytes <32 KiB.
 * Aggregate's supported btree.aggregateBetweenBatch returns count AND sum
 * (aggregate src/component/btree.ts:1279), avoiding duplicate count/sum reads.
 */
export async function readUsage(ctx, args) {
    text(args.subject, "SUBJECT");
    text(args.runId, "RUN");
    if (args.nodeIds.length > LIMITS.maxUsageNodes ||
        new Set(args.nodeIds).size !== args.nodeIds.length)
        throw new Error("INVALID_USAGE_NODES");
    for (const id of args.nodeIds)
        if (id !== null)
            text(id, "NODE");
    const base = ["usage", args.subject, args.runId];
    const total = await readNode(ctx, ["run", args.subject, args.runId], base, args.partial);
    const nodes = [];
    for (const nodeId of args.nodeIds) {
        const namespace = [...base, "node", nodeId ?? ""];
        nodes.push({ nodeId, usage: await readNode(ctx, namespace, namespace, args.partial) });
    }
    return { total, nodes };
}
/** Missing token evidence is null. A real observed zero remains zero. */
async function readNode(ctx, costs, tokens, partial = false) {
    const [estimated, settled, unknown, input, output, missing] = await ctx.runQuery(components.costBySubject.btree.aggregateBetweenBatch, {
        queries: [
            [...costs, "estimate"],
            [...costs, "settled"],
            [...costs, "unknown"],
            [...tokens, "tokens", "inputTokens"],
            [...tokens, "tokens", "outputTokens"],
            [...tokens, "missingTokens"],
        ].map((namespace) => ({ namespace })),
    });
    return {
        inputTokens: input.count ? input.sum : null,
        outputTokens: input.count ? output.sum : null,
        estimatedUsd: estimated.sum / LIMITS.nanosPerUsd,
        settledUsd: settled.sum / LIMITS.nanosPerUsd,
        unknown: unknown.count,
        reporting: partial || unknown.count || missing.count ? "partial" : "available",
    };
}
