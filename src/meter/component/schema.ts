import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const attribution = v.object({
  subject: v.string(),
  rootThreadId: v.optional(v.string()),
  threadId: v.optional(v.string()),
  runId: v.optional(v.string()),
  agent: v.optional(v.string()),
  model: v.optional(v.string()),
});
export const status = v.union(
  v.literal("estimate"),
  v.literal("settled"),
  v.literal("corrected"),
  v.literal("unknown"),
);
export const source = v.union(
  v.literal("estimate"),
  v.literal("inline"),
  v.literal("settlement"),
  v.literal("lookup"),
);
export const breakdowns = v.array(
  v.union(
    v.literal("thread.model"),
    v.literal("thread.provider"),
    v.literal("subject.agent"),
    v.literal("subject.model"),
    v.literal("subject.provider"),
  ),
);
export const event = v.object({
  externalId: v.string(),
  revision: v.number(),
  nanos: v.number(),
  totalNanos: v.number(),
});
export const sinkState = v.array(
  v.object({
    name: v.string(),
    deliveredNanos: v.optional(v.number()),
    revision: v.number(),
    attempts: v.number(),
    pending: v.optional(event),
    failed: v.boolean(),
  }),
);

// Receipt outcomes deliberately exclude the receipt ledger, preventing recursive
// snapshots and keeping every saved result bounded independently of operation count.
const chargeFields = {
  key: v.string(),
  attribution,
  provider: v.string(),
  // Freeze projection membership at creation: later opt-ins must not insert
  // historical charges, and workers must replace exactly the entries that exist.
  breakdowns,
  profile: v.optional(v.string()),
  quantity: v.optional(v.number()),
  status,
  source,
  nanos: v.optional(v.number()),
  credits: v.optional(v.number()),
  providerRequestId: v.optional(v.string()),
  lookupUntil: v.optional(v.number()),
  // Amount revisions describe outcomes; replay identity comes from operation keys.
  revision: v.number(),
  lastStale: v.optional(v.object({ operation: v.string(), revision: v.number() })),
  lookupAttempt: v.optional(v.number()),
  sinkState,
};

export default defineSchema({
  charges: defineTable({
    ...chargeFields,
    operations: v.array(
      v.object({
        key: v.string(),
        outcome: v.object({
          ...chargeFields,
          _id: v.id("charges"),
          _creationTime: v.number(),
        }),
      }),
    ),
  }).index("by_key", ["key"]),
});
