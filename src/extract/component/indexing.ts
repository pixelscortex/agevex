import type { RAG } from "@convex-dev/rag";
import { v } from "convex/values";
import { mutation, internalMutation } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { bounded, integer, LIMITS } from "../limits.js";

type RagApi = ConstructorParameters<typeof RAG>[0];
const fence = { artifactId: v.id("artifacts"), claim: v.string() };
const active = (row: Doc<"artifacts">, claim: string) =>
  row.indexClaim === claim && (row.indexStatus === "cleaning" || row.indexStatus === "running");
const expired = (row: Doc<"artifacts">) => row.indexLeaseUntil! <= Date.now();

/**
 * Index admission reads/patches one <4 KiB artifact, irrespective of retries.
 * Cleaning and embedding share a lease independent of extraction. Expiry only
 * records an unknown outcome; this explicit host admission alone claims recovery.
 * Retain the exact entry id until cleanup finishes, even across repeated crashes.
 * One small scheduled check per admitted attempt stops without scheduling work.
 */
export const admit = mutation({
  args: {
    artifactId: v.id("artifacts"),
    namespace: v.string(),
    key: v.string(),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    bounded(args.namespace);
    bounded(args.key);
    const leaseMs = integer(args.leaseMs ?? LIMITS.indexLeaseMs, LIMITS.indexLeaseMs, 1);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (row?.status !== "ready") throw new Error("EXTRACT_NOT_READY");
    if (row.indexStatus === "cleaning" || row.indexStatus === "running") {
      if (!expired(row)) return { action: "wait" as const, entryId: row.indexEntryId };
      // The timer may not have run yet. Lazy expiry and recovery are atomic:
      // no old writer can pass this row's claim check after this transaction.
      await ctx.db.patch("artifacts", row._id, { indexStatus: "unknown" });
    }
    if (
      row.indexStatus === "ready" &&
      row.indexNamespace === args.namespace &&
      row.indexKey === args.key
    )
      return { action: "reuse" as const, entryId: row.indexEntryId };
    const claim = crypto.randomUUID();
    await ctx.db.patch("artifacts", row._id, {
      indexStatus: "cleaning",
      indexClaim: claim,
      indexLeaseUntil: Date.now() + leaseMs,
      indexNamespace: args.namespace,
      indexKey: args.key,
    });
    await ctx.scheduler.runAfter(leaseMs, internal.indexing.expire, { artifactId: row._id, claim });
    return { action: "run" as const, claim, entryId: row.indexEntryId };
  },
});

/**
 * RAG 0.7.8 src/component/entries.ts:194 exposes native pending-entry creation.
 * A nested mutation shares this transaction: its id and our running state
 * commit together or neither does. No crash can leave an unrecorded entry.
 * Budget: one <4 KiB artifact + one <2 KiB native entry/namespace and bounded
 * indexed latest-version lookups; no chunks/vectors cross this transaction.
 */
export const start = mutation({
  args: {
    ...fence,
    add: v.string(),
    namespaceId: v.string(),
    key: v.string(),
    contentHash: v.string(),
  },
  handler: async (ctx, args) => {
    bounded(args.claim);
    bounded(args.add, LIMITS.urlBytes);
    bounded(args.namespaceId);
    bounded(args.key, LIMITS.hashBytes);
    bounded(args.contentHash, LIMITS.hashBytes);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (
      row?.status !== "ready" ||
      row.indexStatus !== "cleaning" ||
      row.indexClaim !== args.claim ||
      expired(row)
    )
      throw new Error("EXTRACT_INDEX_FENCED");
    const result = await ctx.runMutation(args.add as unknown as RagApi["entries"]["add"], {
      entry: {
        namespaceId: args.namespaceId,
        key: args.key,
        contentHash: args.contentHash,
        importance: 1,
        filterValues: [],
        metadata: { artifactId: row._id, fileId: row.fileId },
      },
    });
    await ctx.db.patch("artifacts", row._id, {
      indexStatus: "running",
      indexEntryId: result.entryId,
    });
    return result.entryId;
  },
});

/**
 * Fence the native write inside the same transaction, rather than checking in
 * the action before an unguarded write. Recovery conflicts on this artifact.
 * RAG 0.7.8 src/component/chunks.ts:50-141 owns chunk/content/vector insertion.
 * At hard maxima: 100*(2*8192+4096*9+1024) = 5,427,200 bytes and 300 rows,
 * plus one <4 KiB artifact, entry and namespace lookups. The exact entry has no
 * predecessor/history after cleanup; each order is written once by this action.
 */
export const insert = mutation({
  args: {
    ...fence,
    insert: v.string(),
    startOrder: v.number(),
    chunks: v.array(
      v.object({
        content: v.object({ text: v.string() }),
        searchableText: v.string(),
        embedding: v.array(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    bounded(args.claim);
    bounded(args.insert, LIMITS.urlBytes);
    integer(args.startOrder, LIMITS.indexChunks);
    integer(args.chunks.length, LIMITS.ragBatch, 1);
    integer(args.startOrder + args.chunks.length, LIMITS.indexChunks);
    for (const chunk of args.chunks) {
      bounded(chunk.content.text, LIMITS.chunkBytes);
      bounded(chunk.searchableText, LIMITS.chunkBytes);
      if (
        !LIMITS.embeddingDimensions.includes(chunk.embedding.length as never) ||
        chunk.embedding.some((value) => !Number.isFinite(value))
      )
        throw new Error("INVALID_EXTRACT_ARGUMENT");
    }
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (!row || !active(row, args.claim)) return false;
    if (expired(row)) {
      await ctx.db.patch("artifacts", row._id, { indexStatus: "unknown" });
      return false;
    }
    if (row.status !== "ready" || row.indexStatus !== "running" || !row.indexEntryId) return false;
    await ctx.runMutation(args.insert as unknown as RagApi["chunks"]["insert"], {
      entryId: row.indexEntryId,
      startOrder: args.startOrder,
      chunks: args.chunks,
    });
    return true;
  },
});

/** Promote and publish under the same claim/release fence, with one exact id. */
export const complete = mutation({
  args: { ...fence, promote: v.optional(v.string()) },
  handler: async (ctx, args) => {
    bounded(args.claim);
    if (args.promote) bounded(args.promote, LIMITS.urlBytes);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (!row || !active(row, args.claim)) return false;
    if (expired(row)) {
      await ctx.db.patch("artifacts", row._id, { indexStatus: "unknown" });
      return false;
    }
    if (!args.promote) {
      await ctx.db.patch("artifacts", row._id, { indexStatus: "failed" });
      return true;
    }
    if (row.status !== "ready" || row.indexStatus !== "running" || !row.indexEntryId) return false;
    // The native key is scoped to this artifact and the preceding entry was
    // deleted by exact id. Its promote scan therefore sees at most our single
    // pending entry, never a history of retries or unrelated artifacts.
    await ctx.runMutation(args.promote as unknown as RagApi["entries"]["promoteToReady"], {
      entryId: row.indexEntryId,
    });
    await ctx.db.patch("artifacts", row._id, { indexStatus: "ready" });
    return true;
  },
});

/** One exact row, no paid work, no rescheduling, and no deletion of its receipt. */
export const expire = internalMutation({
  args: fence,
  handler: async (ctx, args) => {
    bounded(args.claim);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (row && active(row, args.claim) && expired(row))
      await ctx.db.patch("artifacts", row._id, { indexStatus: "unknown" });
    return null;
  },
});
