// Component runtime source; keep host dependencies and environment access outside this boundary.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const sandboxState = v.union(
  v.literal("creating"),
  v.literal("ready"),
  v.literal("stopped"),
  v.literal("unknown"),
  v.literal("deleting"),
  v.literal("deleted"),
);
export const jobState = v.union(
  v.literal("starting"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("unknown"),
);

export default defineSchema({
  sandboxes: defineTable({
    scopeKey: v.string(),
    provider: v.string(),
    sandboxId: v.optional(v.string()),
    state: sandboxState,
    lastUsedAt: v.number(),
    ttl: v.number(),
    // Reservation fences lost create responses; lease expiry NEVER grants a
    // second create. cleanupAt is the indexed, conservative idle deadline.
    claim: v.string(),
    leaseUntil: v.number(),
    cleanupAt: v.optional(v.number()),
  })
    .index("by_scope", ["scopeKey"])
    .index("by_cleanup", ["cleanupAt"]),
  // A separate row per job avoids rewriting an ever-growing jobs array on
  // every lifecycle use. Active rows are admission-bounded per sandbox; exact
  // job ids drive polling. Commands, input and full logs stay with providers.
  jobs: defineTable({
    scopeKey: v.string(),
    subject: v.string(),
    threadId: v.string(),
    runId: v.string(),
    providerJobId: v.optional(v.string()),
    // Saved with the launch reservation, before the remote effect. These
    // locate exit/log/pid files even if the launch response is lost.
    sandboxId: v.string(),
    directory: v.string(),
    state: jobState,
    deadline: v.number(),
    pollMinMs: v.number(),
    pollMaxMs: v.number(),
    delayMs: v.number(),
    pollHandle: v.string(),
    claim: v.string(),
    leaseUntil: v.number(),
    // Claims made at or after the deadline; read by claimPoll to bound them.
    lateAttempts: v.optional(v.number()),
    wakeId: v.optional(v.id("_scheduled_functions")),
    exitCode: v.optional(v.number()),
    logTail: v.optional(v.string()),
    code: v.optional(v.literal("SANDBOX_JOB_DEADLINE")),
  }).index("by_scope_state", ["scopeKey", "state"]),
});
