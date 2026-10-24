/**
 * All runtime bounds live here. The two Workflow pools share the platform's
 * eight scheduled-action slots: two roots and four children leave room for
 * control jobs. Waiting workflows consume no action slot, and a root releases
 * its slot as soon as delegation is queued, so children can always progress.
 * Platform ceilings are documentation as well as a constraint on our defaults;
 * payloads stay in Agent storage rather than consuming the Workflow journal.
 */
import { v } from "convex/values";

/** Workflow 0.4.10 / Convex documented facts, not checked by this SDK.
 * Workflow enforces its journal/step byte ceilings; only ids and small control
 * values cross our steps. These platform facts are never host overrides.
 */
export const PLATFORM = {
  journalBytes: 8 << 20,
  stepBytes: 800 << 10,
  nodeActionMs: 10 * 60_000,
  convexActionMs: 30 * 60_000,
  scheduledConcurrency: 8,
} as const;

export const LIMITS = {
  rootLane: 2,
  childLane: 4,
  slicesPerTurn: 16,
  turnsPerLoop: 50,
  workflowVersion: 1,
  generationAbortMs: 90_000,
  executionWatchdogMs: 120_000,
  cancelPollMs: 1_000,
  // Native messages can approach Convex's 1 MiB document ceiling. Leave room
  // under the 16 MiB transaction budget for listing, finalization and streams.
  cancelCleanupBatch: 4,
  cancelSnapshotPage: 1,
  outputTokens: 4096,
  runLaunches: 12,
  runHops: 24,
  activeChildrenPerRoot: 5,
  taskLength: 4_000,
  queueLength: 20,
  messageLength: 16_000,
  requestKeyLength: 200,
  runEvents: 4,
  maxDelegationPage: 50,
  verificationPage: 20,
  approvalPage: 100,
  leaseMs: 10 * 60_000,
  receiptRetentionMs: 7 * 24 * 60 * 60_000,
  receiptResultBytes: 64 << 10,
  reconcileIntervalMs: 30_000,
  reconcileMaxIntervalMs: 5 * 60_000,
  purgeBatch: 100,
  purgeIntervalMs: 60 * 60_000,
  streamThrottleMs: 0,
  modelRetries: 0,
} as const;

/** Only these policy bounds are tunable; internal safety/platform facts are not. */
export const limitsValidator = v.object({
  rootLane: v.number(),
  childLane: v.number(),
  runLaunches: v.number(),
  runHops: v.number(),
  activeChildrenPerRoot: v.number(),
  taskLength: v.number(),
  queueLength: v.number(),
  slicesPerTurn: v.number(),
  leaseMs: v.number(),
});
export type Limits = { [K in keyof typeof limitsValidator.fields]: number };

/** Fail at registration, before any accepted prompt can launch background work. */
export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  for (const [key, value] of Object.entries(overrides))
    if (
      !Object.prototype.hasOwnProperty.call(limitsValidator.fields, key) ||
      !Number.isSafeInteger(value) ||
      value <= 0
    )
      throw new Error("INVALID_LIMITS: expected positive integer host bounds");
  const merged = Object.fromEntries(
    Object.keys(limitsValidator.fields).map((key) => [
      key,
      overrides[key as keyof Limits] ?? LIMITS[key as keyof Limits],
    ]),
  ) as Limits;
  if (merged.rootLane + merged.childLane > PLATFORM.scheduledConcurrency)
    throw new Error("INVALID_LIMITS: lanes exceed scheduled concurrency");
  return merged;
}
