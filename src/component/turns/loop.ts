/**
 * Registered steps of the loop workflow's doorbell: `next` hands the loop its
 * queued turn token (or null to sleep on a ping) and `reconcile` is the
 * scheduled recovery check that re-rings a loop whose ping was lost. Both
 * delegate to turns/wake.ts. Touches `assignments`; reads the ready `inbox`
 * range.
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server.js";
import { nextQueuedTurn, reconcileDoorbell } from "./wake.js";

/** The loop workflow's step: the queued turn's token, or null to sleep. */
export const next = internalMutation({
  args: { assignmentId: v.id("assignments") },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { assignmentId }): Promise<string | null> => nextQueuedTurn(ctx, assignmentId),
});

/** The scheduled recovery check; see `reconcileDoorbell` in turns/wake.ts. */
export const reconcile = internalMutation({
  args: { assignmentId: v.id("assignments"), recoveryAt: v.optional(v.number()) },
  returns: v.null(),
  handler: (ctx, { assignmentId, recoveryAt }) => reconcileDoorbell(ctx, assignmentId, recoveryAt),
});
