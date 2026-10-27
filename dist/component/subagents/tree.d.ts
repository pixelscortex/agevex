import type { Doc } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import { type RunTree } from "../run_tree_values.js";
/** All rows share the root budget, whose immutable limits bounded reservation.
 * Hard ceilings are derived centrally rather than trusting query arguments.
 */
export declare function requestTree(ctx: QueryCtx, root: Doc<"assignments">, rootRunId?: string): Promise<RunTree>;
