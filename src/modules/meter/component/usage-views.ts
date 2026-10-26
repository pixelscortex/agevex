/** Bounded reactive usage views for host queries and the optional core slot.
 * One owned run plus <=59 known nodes; no charge or transcript discovery.
 */
import { v, type Infer } from "convex/values";
import type { QueryCtx } from "./_generated/server.js";
import { bySubject, summary } from "./aggregates.js";
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
  reporting: v.union(v.literal("available"), v.literal("partial"), v.literal("disabled")),
});
export const usageProjection = v.object({
  total: usageView,
  nodes: v.array(v.object({ nodeId: v.union(v.string(), v.null()), usage: usageView })),
});

/** Complete namespaces read <=7 docs per aggregate operation (lazy root and
 * <=5 children plus metadata). 60*(4 cost + 4 token) <=3360 docs / <7 MiB
 * at <=2 KiB/node; <4096 queries. Output <=60*512 bytes <32 KiB.
 */
export async function readUsage(
  ctx: QueryCtx,
  args: Infer<ReturnType<typeof v.object<typeof usageViewArgs>>>,
) {
  text(args.subject, "SUBJECT");
  text(args.runId, "RUN");

  if (
    args.nodeIds.length > LIMITS.maxUsageNodes ||
    new Set(args.nodeIds).size !== args.nodeIds.length
  )
    throw new Error("INVALID_USAGE_NODES");

  for (const id of args.nodeIds) if (id !== null) text(id, "NODE");

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
async function readNode(ctx: QueryCtx, costs: string[], tokens: string[], partial = false) {
  const cost = await summary(ctx, bySubject, costs);
  const input = [...tokens, "tokens", "inputTokens"];
  const count = await bySubject.count(ctx, { namespace: input });
  const missing = await bySubject.count(ctx, { namespace: [...tokens, "missingTokens"] });
  const inputTokens = await bySubject.sum(ctx, { namespace: input });

  const outputTokens = await bySubject.sum(ctx, {
    namespace: [...tokens, "tokens", "outputTokens"],
  });

  return {
    inputTokens: count ? inputTokens : null,
    outputTokens: count ? outputTokens : null,
    estimatedUsd: cost.usd.estimated,
    settledUsd: cost.usd.settled,
    unknown: cost.unknown,
    reporting: partial || cost.unknown || missing ? ("partial" as const) : ("available" as const),
  };
}
