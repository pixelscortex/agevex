import { type RuntimeContext } from "./context.js";
import type { ActionCtx, WorkerArgs } from "./types.js";
/** Claim once, publish under the same fence, then account and clean only unreferenced blobs. */
export declare function execute(runtime: RuntimeContext, ctx: ActionCtx, args: WorkerArgs): Promise<null>;
