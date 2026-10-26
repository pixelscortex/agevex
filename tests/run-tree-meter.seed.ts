/** Dense lazy aggregate roots exercise the meter's full seven-document reads. */
import aggregate from "@convex-dev/aggregate/test";
import { mutationGeneric, type FunctionReference } from "convex/server";
import { v, getConvexSize } from "convex/values";
import type { Test } from "./run-tree.fixture.js";
import { LIMITS } from "../src/modules/meter/shared/limits.js";

const MOUNT = "meter/costBySubject";

/** The unbounded full-namespace aggregate reads exactly metadata, lazy root and
 * five cached children, independent of hypothetical descendant tree depth.
 */
export function registerUsageSeed(t: Test) {
  t.registerComponent(MOUNT, aggregate.schema, {
    ...aggregate.modules,
    "./component/treeUsageSeed.ts": async () => ({
      seed: mutationGeneric({
        args: { namespaces: v.array(v.array(v.string())) },
        handler: async (ctx, { namespaces }) => {
          for (const namespace of namespaces) {
            const items = Array.from({ length: LIMITS.aggregateNodeSize }, (_, i) => ({
              k: [["", 0], String(i)],
              v: String(i).padEnd(380, "v"),
              s: 1,
            }));

            const subtrees = [];

            for (let i = 0; i <= LIMITS.aggregateNodeSize; i++)
              subtrees.push(
                await ctx.db.insert("btreeNode", {
                  items,
                  subtrees: [],
                  aggregate: { count: items.length, sum: items.length },
                }),
              );

            const row = { items, subtrees };

            if (getConvexSize(row) + 128 > LIMITS.nodeBytes)
              throw new Error("NODE_FIXTURE_TOO_LARGE");

            const root = await ctx.db.insert("btreeNode", row);

            await ctx.db.insert("btree", {
              namespace,
              root,
              maxNodeSize: LIMITS.aggregateNodeSize,
            });
          }

          return null;
        },
      }),
    }),
  });

  return `function://${MOUNT};treeUsageSeed:seed` as unknown as FunctionReference<
    "mutation",
    "internal",
    { namespaces: string[][] },
    null
  >;
}

/** Six complete namespaces per exclusive node and six for the request total. */
export async function seedUsage(
  t: Test,
  subject: string,
  runId: string,
  nodeIds: (string | null)[],
) {
  const seed = registerUsageSeed(t);
  const base = ["usage", subject, runId];
  const nodes = [undefined, ...nodeIds];

  for (const node of nodes) {
    const tokens = node === undefined ? base : [...base, "node", node ?? ""];
    const costs = node === undefined ? ["run", subject, runId] : tokens;

    await t.mutation(seed, {
      namespaces: [
        ...["estimate", "settled", "unknown"].map((state) => [...costs, state]),
        [...tokens, "tokens", "inputTokens"],
        [...tokens, "tokens", "outputTokens"],
        [...tokens, "missingTokens"],
      ],
    });
  }
}
