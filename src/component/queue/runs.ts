/**
 * Row builder for the `runs` table.
 *
 * A run is one accepted user request and all the work it causes: every turn,
 * delegated child, delivered result and hook continuation spends from the same
 * launch/hop/continue/side-run counters. `queue.accept` creates one per send;
 * descendants inherit its id. Claim reads the per-agent model choice fixed
 * here, and cancel marks the run cancelled for every assignment under it.
 */
import type { WithoutSystemFields } from "convex/server";
import type { Doc } from "../_generated/dataModel.js";

/** The fresh budget for one accepted send. `models` is the thread's model
 * policy at acceptance, snapshotted so later sends cannot change a live run. */
export function newRun(models: Doc<"runs">["models"]): WithoutSystemFields<Doc<"runs">> {
  return {
    models,
    // 64-bit agent-index masks: who started in this run / who owns routing.
    startedAgents: 0n,
    routingAgents: 0n,
    // Spend counters, each checked against its limits.ts bound.
    continues: 0,
    sideRuns: 0,
    launches: 0,
    hops: 0,
    cancelled: false,
  };
}
