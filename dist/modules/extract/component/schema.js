/**
 * Artifact receipts and per-namespace indexing state, with shared wire validators.
 * Registered functions use identity, failure, usage, and summary validators from this file.
 * Tables store only bounded metadata; file bytes and searchable content stay outside them.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export const failure = v.union(v.literal("UNSUPPORTED_TYPE"), v.literal("UNREADABLE"), v.literal("EMPTY"), v.literal("INVALID_OUTPUT"), v.literal("TOO_LARGE"), v.literal("PROVIDER_UNAVAILABLE"), v.literal("OBJECT_UNAVAILABLE"), v.literal("CHECKSUM_FAILED"));
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
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("ready"), v.literal("failed"), v.literal("unknown"), v.literal("released")),
        attempt: v.number(),
        claim: v.string(),
        leaseUntil: v.number(),
        summary: v.optional(summary),
        payloadStorageId: v.optional(v.string()),
        failure: v.optional(failure),
        usage: v.optional(usage),
        // Distinct completion callback handles of every admitter of this identity
        // (LIMITS.callbacksPerArtifact of LIMITS.callbackBytes). Read and cleared by
        // the dispatch that owns the row when its workflow completes, so a caller
        // superseded by a re-dispatch or a retry still gets exactly one callback.
        callbacks: v.optional(v.array(v.string())),
    })
        .index("by_identity", ["fileId", "backend", "version", "optionsHash"])
        // Host-only purge walks every extraction of one native file.
        // Releases traverse artifacts in creation order; the identity index sorts by backend.
        // eslint-disable-next-line @convex-dev/no-duplicate-indexes
        .index("by_file", ["fileId"]),
    /**
     * One row per (artifact, namespace). Agent dedupes uploads by hash, so several
     * threads or uploaders legitimately share one artifact; each gets its own
     * index record and native RAG entry, and none can clean up another's.
     * Written only by the optional RAG phase; every field is read by it.
     */
    indexes: defineTable({
        artifactId: v.id("artifacts"),
        namespace: v.string(),
        key: v.string(),
        status: v.union(v.literal("cleaning"), v.literal("running"), v.literal("unknown"), v.literal("failed"), v.literal("ready"), v.literal("released")),
        claim: v.string(),
        leaseUntil: v.number(),
        entryId: v.optional(v.string()),
    }).index("by_artifact_namespace", ["artifactId", "namespace"]),
});
