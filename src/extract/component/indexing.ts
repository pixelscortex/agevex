import type { RAG } from "@convex-dev/rag";
import { v } from "convex/values";
import { mutation } from "./_generated/server.js";
import { bounded, LIMITS } from "../limits.js";

type RagApi = ConstructorParameters<typeof RAG>[0];
const fence = { artifactId: v.id("artifacts"), claim: v.string() };

/**
 * Index admission reads/patches one <4 KiB artifact, irrespective of retries.
 * No lease takeover: losing an action must never allow another action to
 * delete its entry while it could still be embedding/writing. Only an explicit
 * completed failure permits a caller-requested retry; nothing retries paid work
 * automatically. Cleaning owns the same fence as running, including deletion.
 */
export const admit = mutation({
  args: { artifactId: v.id("artifacts"), namespace: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    bounded(args.namespace);
    bounded(args.key);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (row?.status !== "ready") throw new Error("EXTRACT_NOT_READY");
    if (row.indexStatus === "cleaning" || row.indexStatus === "running")
      return { action: "wait" as const, entryId: row.indexEntryId };
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
      indexNamespace: args.namespace,
      indexKey: args.key,
    });
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
    if (row?.status !== "ready" || row.indexStatus !== "cleaning" || row.indexClaim !== args.claim)
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

/** Promote and publish under the same claim/release fence, with one exact id. */
export const complete = mutation({
  args: { ...fence, promote: v.optional(v.string()) },
  handler: async (ctx, args) => {
    bounded(args.claim);
    if (args.promote) bounded(args.promote, LIMITS.urlBytes);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (
      !row ||
      row.indexClaim !== args.claim ||
      (row.indexStatus !== "cleaning" && row.indexStatus !== "running")
    )
      return false;
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
