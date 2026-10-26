/** Exclusive node costs and token totals in the meter's existing aggregate.
 * Namespaces make each complete node read constant-size, regardless of steps.
 * Token evidence is immutable; replacing cost evidence never counts it twice.
 */
import type { Doc } from "./_generated/dataModel.js";
import type { Group, Projection, Tree } from "./aggregates.js";
/** At most five extra projections: one node cost and run/node × two token sums.
 * Thirteen total projections (3 D=10, 10 D=24) replace <=3061 nodes read
 * (<6 MiB) and <=1942 written (<3.8 MiB), plus charge/outbox <1 MiB.
 * Tokens <=1e9 each; 100k thread charges sum <=1e14, below 2^53.
 */
export declare function usageProjections(row: Doc<"charges">, tree: Tree, state: Group): Projection[];
