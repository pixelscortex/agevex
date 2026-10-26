import type { Id } from "./_generated/dataModel.js";
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
export declare const admit: import("convex/server").RegisteredMutation<"public", {
    leaseMs?: number | undefined;
    automatic?: boolean | undefined;
    key: string;
    artifactId: import("convex/values").GenericId<"artifacts">;
    namespace: string;
}, Promise<{
    action: "wait";
    indexId: import("convex/values").GenericId<"indexes">;
    entryId: string | undefined;
    claim?: undefined;
} | {
    action: "reuse";
    indexId: import("convex/values").GenericId<"indexes">;
    entryId: string | undefined;
    claim?: undefined;
} | {
    action: "skip";
    indexId: import("convex/values").GenericId<"indexes">;
    entryId: string | undefined;
    claim?: undefined;
} | {
    action: "run";
    indexId: import("convex/values").GenericId<"indexes">;
    claim: `${string}-${string}-${string}-${string}-${string}`;
    entryId: string | undefined;
}>>;
/** Read-only view for search: only a ready record in the caller's namespace counts.
 * `claim` is the stale-writer fence token, not a credential; do not log it. */
export declare const lookup: import("convex/server").RegisteredQuery<"public", {
    artifactId: import("convex/values").GenericId<"artifacts">;
    namespace: string;
}, Promise<{
    indexId: import("convex/values").GenericId<"indexes">;
    status: "failed" | "running" | "unknown" | "ready" | "released" | "cleaning";
    key: string;
    leaseUntil: number;
    entryId: string | undefined;
    claim: string;
} | null>>;
/**
 * Stop one namespace's index. The row is fenced (`released`) in this
 * transaction so any late writer fails its claim check, and its exact entry id
 * is returned for the host to delete natively. The shared extraction and every
 * other namespace's index are untouched.
 */
export declare const release: import("convex/server").RegisteredMutation<"public", {
    artifactId: import("convex/values").GenericId<"artifacts">;
    namespace: string;
}, Promise<{
    indexId: import("convex/values").GenericId<"indexes">;
    entryId: string | null;
} | null>>;
/**
 * One bounded batch of an artifact's index records for `purge`: fence up to
 * `limit` (<= LIMITS.purgeBatch = 32) rows as released and return their exact
 * entry ids for native deletion. `more` says rows remain beyond the batch.
 * Budget: 33 rows read, 32 patched, each < 1 KiB.
 */
export declare const purgeBatch: import("convex/server").RegisteredMutation<"public", {
    limit: number;
    artifactId: import("convex/values").GenericId<"artifacts">;
}, Promise<{
    entries: {
        indexId: Id<"indexes">;
        entryId: string | null;
    }[];
    more: boolean;
}>>;
/** Drop a released record once its native entry is gone; a re-admitted record stays. */
export declare const forget: import("convex/server").RegisteredMutation<"public", {
    entryId: string | null;
    indexId: import("convex/values").GenericId<"indexes">;
}, Promise<null>>;
/**
 * RAG 0.7.8 src/component/entries.ts:194 exposes native pending-entry creation.
 * A nested mutation shares this transaction: its id and our running state
 * commit together or neither does. No crash can leave an unrecorded entry.
 * Budget: one <4 KiB artifact + one <1 KiB index row + one <2 KiB native
 * entry/namespace and bounded indexed latest-version lookups; no
 * chunks/vectors cross this transaction.
 */
export declare const start: import("convex/server").RegisteredMutation<"public", {
    key: string;
    claim: string;
    indexId: import("convex/values").GenericId<"indexes">;
    add: string;
    namespaceId: string;
    contentHash: string;
}, Promise<string>>;
/**
 * Fence the native write inside the same transaction, rather than checking in
 * the action before an unguarded write. Recovery conflicts on this row.
 * RAG 0.7.8 src/component/chunks.ts:50-141 owns chunk/content/vector insertion.
 * At hard maxima: 100*(2*8192+4096*9+1024) = 5,427,200 bytes and 300 rows,
 * plus one <4 KiB artifact, one index row, entry and namespace lookups. The
 * exact entry has no predecessor/history after cleanup; each order is written
 * once by this action.
 */
export declare const insert: import("convex/server").RegisteredMutation<"public", {
    claim: string;
    startOrder: number;
    indexId: import("convex/values").GenericId<"indexes">;
    insert: string;
    chunks: {
        content: {
            text: string;
        };
        searchableText: string;
        embedding: number[];
    }[];
}, Promise<boolean>>;
/** Promote and publish under the same claim/purge fence, with one exact id. */
export declare const complete: import("convex/server").RegisteredMutation<"public", {
    promote?: string | undefined;
    claim: string;
    indexId: import("convex/values").GenericId<"indexes">;
}, Promise<boolean>>;
/** One exact row, no paid work, no rescheduling, and no deletion of its receipt. */
export declare const expire: import("convex/server").RegisteredMutation<"internal", {
    claim: string;
    indexId: import("convex/values").GenericId<"indexes">;
}, Promise<null>>;
