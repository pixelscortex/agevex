/** One reactive, request-scoped run tree. Native Agent owns all message bodies.
 * D = HOST_LIMITS.runLaunches.max + sideRunsPerRun.max = 58.
 * (1+D)*34 KiB assignments +D*4 KiB children +3*34 KiB ownership
 * +2*16 KiB root metadata +1 KiB ready probe = 2373 KiB core reads.
 * Meter's batched projection adds <=5160 KiB: combined <=7533 KiB <8 MiB;
 * The host checks both Convex and JSON output bytes against 128 KiB.
 * No per-node transcript, meter or settlement scans: reuse the already bounded
 * child set to project transitive ordinary delivery/group fences in memory.
 */
import type { Doc } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import { type RunTree } from "../run_tree_values.js";
/** All rows share the root budget, whose immutable limits bounded reservation.
 * Hard ceilings are derived centrally rather than trusting query arguments.
 */
export declare function requestTree(ctx: QueryCtx, root: Doc<"assignments">, rootRunId?: string): Promise<RunTree>;
