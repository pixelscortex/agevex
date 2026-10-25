import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export const failure = v.union(
  v.literal("UNSUPPORTED_TYPE"),
  v.literal("UNREADABLE"),
  v.literal("EMPTY"),
  v.literal("INVALID_OUTPUT"),
  v.literal("TOO_LARGE"),
  v.literal("PROVIDER_UNAVAILABLE"),
  v.literal("OBJECT_UNAVAILABLE"),
  v.literal("CHECKSUM_FAILED"),
);
export const usage = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  credits: v.optional(v.number()),
});
export const summary = v.object({
  kind: v.union(v.literal("text"), v.literal("document"), v.literal("image")),
  textBytes: v.number(),
  pages: v.number(),
  preview: v.string(),
  language: v.optional(v.string()),
});
export const identity = {
  fileId: v.string(),
  backend: v.string(),
  version: v.string(),
  optionsHash: v.string(),
};
export default defineSchema({
  artifacts: defineTable({
    ...identity,
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("unknown"),
      v.literal("released"),
    ),
    attempt: v.number(),
    claim: v.string(),
    leaseUntil: v.number(),
    summary: v.optional(summary),
    payloadStorageId: v.optional(v.string()),
    failure: v.optional(failure),
    usage: v.optional(usage),
    indexStatus: v.optional(
      v.union(
        v.literal("cleaning"),
        v.literal("running"),
        v.literal("unknown"),
        v.literal("failed"),
        v.literal("ready"),
      ),
    ),
    indexClaim: v.optional(v.string()),
    indexLeaseUntil: v.optional(v.number()),
    indexEntryId: v.optional(v.string()),
    indexNamespace: v.optional(v.string()),
    indexKey: v.optional(v.string()),
  }).index("by_identity", ["fileId", "backend", "version", "optionsHash"]),
});
