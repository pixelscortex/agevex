import { LIMITS } from "../shared/limits.js";
/** At most five extra projections: one node cost and run/node × two token sums.
 * Thirteen total projections (3 D=10, 10 D=24) replace <=3061 nodes read
 * (<6 MiB) and <=1942 written (<3.8 MiB), plus charge/outbox <1 MiB.
 * Tokens <=1e9 each; 100k thread charges sum <=1e14, below 2^53.
 */
export function usageProjections(row, tree, state) {
    const { subject, runId, nodeId } = row.attribution;
    if (!runId)
        return [];
    const namespace = ["usage", subject, runId];
    const node = nodeId ?? "";
    const entry = (suffix, value) => ({
        tree,
        key: ["", 0],
        namespace: [...namespace, ...suffix],
        depth: LIMITS.subjectTreeDepth,
        ...(value === undefined ? {} : { value }),
    });
    const entries = [entry(["node", node, state])];
    if (row.tokens)
        for (const metric of ["inputTokens", "outputTokens"]) {
            entries.push(entry(["tokens", metric], row.tokens[metric]));
            entries.push(entry(["node", node, "tokens", metric], row.tokens[metric]));
        }
    else if (row.attribution.purpose === "agent") {
        // Known cost does not imply known token usage. Tools need not report tokens.
        entries.push(entry(["missingTokens"], 0));
        entries.push(entry(["node", node, "missingTokens"], 0));
    }
    return entries;
}
