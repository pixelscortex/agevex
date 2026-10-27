/**
 * Row builder for the `runs` table.
 *
 * A run is one accepted user request and all the work it causes: every turn,
 * delegated child and delivered result spends from the same
 * launch/hop counters. `turns.send.accept` creates one per send;
 * descendants inherit its id. Claim reads the per-agent model choice fixed
 * here, and cancel marks the run cancelled for every assignment under it.
 */
import type { WithoutSystemFields } from "convex/server";
import type { Doc } from "../_generated/dataModel.js";
/** The fresh budget for one accepted send. `models` is the thread's model
 * policy at acceptance, snapshotted so later sends cannot change a live run. */
export declare function newRun(models: Doc<"runs">["models"], settings?: Doc<"runs">["settings"], metadata?: Pick<Doc<"runs">, "rootAssignmentId" | "rootCancellationEpoch" | "taskMessageId">): WithoutSystemFields<Doc<"runs">>;
