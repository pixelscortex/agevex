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

export default defineSchema({
  charges: defineTable({
    key: v.string(),
    attribution,
    provider: v.string(),
    profile: v.optional(v.string()),
    quantity: v.optional(v.number()),
    status,
    source,
    nanos: v.optional(v.number()),
    credits: v.optional(v.number()),
    providerRequestId: v.optional(v.string()),
    lookupUntil: v.optional(v.number()),
    sinkState,
  }).index("by_key", ["key"]),
});
