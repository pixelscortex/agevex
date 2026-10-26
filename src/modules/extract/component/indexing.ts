/**
 * Registered namespace index API and atomic fences around native RAG writes.
 * Host indexing actions call these functions while RAG owns content, chunks, and vectors.
 * Each indexes row records one artifact/namespace claim and its exact native entry id.
 */
import type { RAG } from "@convex-dev/rag";
import { v } from "convex/values";
import { bounded, integer, LIMITS } from "../shared/limits.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query } from "./_generated/server.js";

type RagApi = ConstructorParameters<typeof RAG>[0];
const fence = { indexId: v.id("indexes"), claim: v.string() };

/** Accept writes only for the same cleaning or running claim, protecting namespace isolation. */
const active = (row: Doc<"indexes">, claim: string) =>
  row.claim === claim && (row.status === "cleaning" || row.status === "running");

/** Check the admission lease without scheduling or retrying paid work. */
const expired = (row: Doc<"indexes">) => row.leaseUntil <= Date.now();

/** Read one exact artifact/namespace row through its bounded identity index. */
const byTarget = (ctx: { db: any }, artifactId: string, namespace: string) =>
  ctx.db
    .query("indexes")
    .withIndex("by_artifact_namespace", (q: any) =>
      q.eq("artifactId", artifactId).eq("namespace", namespace),
    )
    .unique() as Promise<Doc<"indexes"> | null>;

/**
 * Index state is one row per (artifact, namespace). Agent dedupes uploads by
 * hash, so one extraction can be attached to many threads; each thread's
 * namespace has its own record and its own native RAG entry, so indexing,
 * recovery or releasing one namespace can never delete or fence another's.
 *
 * Index admission reads one <4 KiB artifact and one <1 KiB index row and
 * patches one row, irrespective of retries or how many namespaces share the
 * artifact. Cleaning and embedding share a lease independent of extraction.
 * Expiry only records an unknown outcome; an explicit host admission alone
 * claims recovery. The exact entry id is retained until cleanup finishes, even
 * across repeated crashes. One small scheduled check per admitted attempt
 * stops without scheduling work.
 */
export const admit = mutation({
  args: {
    artifactId: v.id("artifacts"),
    namespace: v.string(),
    key: v.string(),
    leaseMs: v.optional(v.number()),
    // Set by automatic callers (the slot, the worker). They may create a
    // missing record but never re-run a failed, unknown, released or replaced
    // one: that is paid embedding, which only an explicit host `index()` may
    // choose to repeat.
    automatic: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    bounded(args.namespace);
    bounded(args.key);
    const leaseMs = integer(args.leaseMs ?? LIMITS.indexLeaseMs, LIMITS.indexLeaseMs, 1);
    const artifact = await ctx.db.get("artifacts", args.artifactId);

    if (artifact?.status !== "ready") throw new Error("EXTRACT_NOT_READY");

    const row = await byTarget(ctx, args.artifactId, args.namespace);
    const claim = crypto.randomUUID();
    const leaseUntil = Date.now() + leaseMs;

    if (!row) {
      const indexId = await ctx.db.insert("indexes", {
        artifactId: args.artifactId,
        namespace: args.namespace,
        key: args.key,
        status: "cleaning",
        claim,
        leaseUntil,
      });

      await ctx.scheduler.runAfter(leaseMs, internal.indexing.expire, { indexId, claim });

      return { action: "run" as const, indexId, claim, entryId: undefined };
    }

    if (row.status === "cleaning" || row.status === "running") {
      if (!expired(row)) return { action: "wait" as const, indexId: row._id, entryId: row.entryId };

      // The timer may not have run yet. Lazy expiry and recovery are atomic:
      // no old writer can pass this row's claim check after this transaction.
      await ctx.db.patch("indexes", row._id, { status: "unknown" });
    } else if (row.status === "ready" && row.key === args.key) {
      return { action: "reuse" as const, indexId: row._id, entryId: row.entryId };
    }

    if (args.automatic) return { action: "skip" as const, indexId: row._id, entryId: row.entryId };

    await ctx.db.patch("indexes", row._id, {
      status: "cleaning",
      claim,
      leaseUntil,
      key: args.key,
    });

    await ctx.scheduler.runAfter(leaseMs, internal.indexing.expire, { indexId: row._id, claim });

    return { action: "run" as const, indexId: row._id, claim, entryId: row.entryId };
  },
});

/** Read-only view for search: only a ready record in the caller's namespace counts.
 * `claim` is the stale-writer fence token, not a credential; do not log it. */
export const lookup = query({
  args: { artifactId: v.id("artifacts"), namespace: v.string() },
  handler: async (ctx, args) => {
    bounded(args.namespace);
    const row = await byTarget(ctx, args.artifactId, args.namespace);

    return row
      ? {
          indexId: row._id,
          status: row.status,
          key: row.key,
          leaseUntil: row.leaseUntil,
          entryId: row.entryId,
          claim: row.claim,
        }
      : null;
  },
});

/**
 * Stop one namespace's index. The row is fenced (`released`) in this
 * transaction so any late writer fails its claim check, and its exact entry id
 * is returned for the host to delete natively. The shared extraction and every
 * other namespace's index are untouched.
 */
export const release = mutation({
  args: { artifactId: v.id("artifacts"), namespace: v.string() },
  handler: async (ctx, args) => {
    bounded(args.namespace);
    const row = await byTarget(ctx, args.artifactId, args.namespace);

    if (!row) return null;

    if (row.status !== "released") await ctx.db.patch("indexes", row._id, { status: "released" });

    return { indexId: row._id, entryId: row.entryId ?? null };
  },
});

/**
 * One bounded batch of an artifact's index records for `purge`: fence up to
 * `limit` (<= LIMITS.purgeBatch = 32) rows as released and return their exact
 * entry ids for native deletion. `more` says rows remain beyond the batch.
 * Budget: 33 rows read, 32 patched, each < 1 KiB.
 */
export const purgeBatch = mutation({
  args: { artifactId: v.id("artifacts"), limit: v.number() },
  handler: async (ctx, args) => {
    const limit = integer(args.limit, LIMITS.purgeBatch, 1);

    const rows = await ctx.db
      .query("indexes")
      .withIndex("by_artifact_namespace", (q) => q.eq("artifactId", args.artifactId))
      .take(limit + 1);

    const entries: { indexId: Id<"indexes">; entryId: string | null }[] = [];

    for (const row of rows.slice(0, limit)) {
      if (row.status !== "released") await ctx.db.patch("indexes", row._id, { status: "released" });

      entries.push({ indexId: row._id, entryId: row.entryId ?? null });
    }

    return { entries, more: rows.length > limit };
  },
});

/** Drop a released record once its native entry is gone; a re-admitted record stays. */
export const forget = mutation({
  args: { indexId: v.id("indexes"), entryId: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("indexes", args.indexId);

    if (row?.status === "released" && (row.entryId ?? null) === args.entryId)
      await ctx.db.delete("indexes", row._id);

    return null;
  },
});

/**
 * RAG 0.7.8 src/component/entries.ts:194 exposes native pending-entry creation.
 * A nested mutation shares this transaction: its id and our running state
 * commit together or neither does. No crash can leave an unrecorded entry.
 * Budget: one <4 KiB artifact + one <1 KiB index row + one <2 KiB native
 * entry/namespace and bounded indexed latest-version lookups; no
 * chunks/vectors cross this transaction.
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
    const row = await ctx.db.get("indexes", args.indexId);
    const artifact = row && (await ctx.db.get("artifacts", row.artifactId));

    if (
      !row ||
      artifact?.status !== "ready" ||
      row.status !== "cleaning" ||
      row.claim !== args.claim ||
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
        metadata: { artifactId: artifact._id, fileId: artifact.fileId },
      },
    });

    await ctx.db.patch("indexes", row._id, { status: "running", entryId: result.entryId });

    return result.entryId;
  },
});

/**
 * Fence the native write inside the same transaction, rather than checking in
 * the action before an unguarded write. Recovery conflicts on this row.
 * RAG 0.7.8 src/component/chunks.ts:50-141 owns chunk/content/vector insertion.
 * At hard maxima: 100*(2*8192+4096*9+1024) = 5,427,200 bytes and 300 rows,
 * plus one <4 KiB artifact, one index row, entry and namespace lookups. The
 * exact entry has no predecessor/history after cleanup; each order is written
 * once by this action.
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

    const row = await ctx.db.get("indexes", args.indexId);

    if (!row || !active(row, args.claim)) return false;

    if (expired(row)) {
      await ctx.db.patch("indexes", row._id, { status: "unknown" });

      return false;
    }

    const artifact = await ctx.db.get("artifacts", row.artifactId);

    if (artifact?.status !== "ready" || row.status !== "running" || !row.entryId) return false;

    await ctx.runMutation(args.insert as unknown as RagApi["chunks"]["insert"], {
      entryId: row.entryId,
      startOrder: args.startOrder,
      chunks: args.chunks,
    });

    return true;
  },
});

/** Promote and publish under the same claim/purge fence, with one exact id. */
export const complete = mutation({
  args: { ...fence, promote: v.optional(v.string()) },
  handler: async (ctx, args) => {
    bounded(args.claim);

    if (args.promote) bounded(args.promote, LIMITS.urlBytes);

    const row = await ctx.db.get("indexes", args.indexId);

    if (!row || !active(row, args.claim)) return false;

    if (expired(row)) {
      await ctx.db.patch("indexes", row._id, { status: "unknown" });

      return false;
    }

    if (!args.promote) {
      await ctx.db.patch("indexes", row._id, { status: "failed" });

      return true;
    }

    const artifact = await ctx.db.get("artifacts", row.artifactId);

    if (artifact?.status !== "ready" || row.status !== "running" || !row.entryId) return false;

    // The native key is scoped to this artifact and namespace, and the
    // preceding entry was deleted by exact id. Its promote scan therefore sees
    // at most our single pending entry, never a history of retries or other
    // namespaces' entries.
    await ctx.runMutation(args.promote as unknown as RagApi["entries"]["promoteToReady"], {
      entryId: row.entryId,
    });

    await ctx.db.patch("indexes", row._id, { status: "ready" });

    return true;
  },
});

/** One exact row, no paid work, no rescheduling, and no deletion of its receipt. */
export const expire = internalMutation({
  args: fence,
  handler: async (ctx, args) => {
    bounded(args.claim);
    const row = await ctx.db.get("indexes", args.indexId);

    if (row && active(row, args.claim) && expired(row))
      await ctx.db.patch("indexes", row._id, { status: "unknown" });

    return null;
  },
});
