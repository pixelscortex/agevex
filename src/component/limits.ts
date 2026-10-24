/**
 * All runtime bounds live here. The two Workflow pools share the platform's
 * eight scheduled-action slots: two roots and four children leave room for
 * control jobs. Waiting workflows consume no action slot, and a root releases
 * its slot as soon as delegation is queued, so children can always progress.
 * Platform ceilings are documentation as well as a constraint on our defaults;
 * payloads stay in Agent storage rather than consuming the Workflow journal.
 */
export const LIMITS = {
  journalBytes: 8 << 20,
  stepBytes: 800 << 10,
  nodeActionMs: 10 * 60_000,
  convexActionMs: 30 * 60_000,
  scheduledConcurrency: 8,
  rootLane: 2,
  childLane: 4,
  slicesPerTurn: 16,
  turnsPerLoop: 50,
  workflowVersion: 1,
  generationAbortMs: 90_000,
  executionWatchdogMs: 120_000,
  cancelPollMs: 1_000,
  outputTokens: 4096,
  runLaunches: 12,
  runHops: 24,
  activeChildrenPerRoot: 5,
  taskLength: 4_000,
  queueLength: 20,
  messageLength: 16_000,
  requestKeyLength: 200,
  runEvents: 4,
  delegationPage: 20,
  maxDelegationPage: 50,
  verificationPage: 20,
  approvalPage: 100,
  leaseMs: 10 * 60_000,
  receiptRetentionMs: 7 * 24 * 60 * 60_000,
  receiptResultBytes: 64 << 10,
  purgeBatch: 100,
  purgeIntervalMs: 60 * 60_000,
  liveOutputTokens: 2048,
  liveRequests: 8,
  liveMaxUsd: 0.05,
  streamThrottleMs: 0,
  modelRetries: 0,
} as const;
