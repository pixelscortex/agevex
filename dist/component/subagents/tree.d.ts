/** One reactive, request-scoped run tree. Native Agent owns all message bodies.
 * D = HOST_LIMITS.runLaunches.max = 50.
 * (1+D)*14 KiB assignments +D*4 KiB children +3*14 KiB ownership
 * +14 KiB root assignment +16 KiB run metadata +1 KiB ready probe = 987 KiB core reads.
 * Any app usage projection is responsible for its own bounded reads.
 * The host checks both Convex and JSON output bytes against 128 KiB.
 * No per-node transcript or settlement scans: reuse the already bounded
 * child set to project transitive delivery fences in memory.
 */
import type { Doc } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import { type RunTree } from "../run_tree_values.js";
/** All rows share the root budget, whose immutable limits bounded reservation.
 * Hard ceilings are derived centrally rather than trusting query arguments.
 */
export declare function requestTree(ctx: QueryCtx, root: Doc<"assignments">, rootRunId?: string): Promise<RunTree>;
