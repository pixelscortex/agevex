import { type ArtifactArgs, type RuntimeContext } from "./context.js";
import type { ActionCtx } from "./types.js";
/**
 * Remove one namespace's index of a shared extraction: the caller's thread
 * namespace by default. The extraction and every other namespace's index
 * stay. Use `purge` for storage cleanup.
 */
export declare function release(runtime: RuntimeContext, ctx: ActionCtx, args: ArtifactArgs & {
    namespace?: string;
}): Promise<null>;
/**
 * ADMIN operation, not an agent or per-thread one. Agent dedupes uploads by
 * hash, so every thread and uploader that attached the same bytes shares
 * these extractions. Purge tombstones all extractions of `fileId` (the
 * no-repeat receipt and reported usage stay), deletes their payload blobs,
 * and removes the RAG content of every namespace that indexed them: each
 * index record is fenced, its native entry deleted by exact id, and the
 * record dropped, so no orphaned chunks or vectors remain. It performs no
 * `authorize` call: expose it only behind your own admin check.
 *
 * Work per call is bounded (at most LIMITS.purgeBatch index records) and
 * nothing reschedules itself: loop until `more` is false.
 * `do { r = await extract.purge(ctx, { fileId }); } while (r.more);`
 */
export declare function purge(runtime: RuntimeContext, ctx: ActionCtx, args: {
    fileId: string;
}): Promise<{
    more: boolean;
}>;
