import { LIMITS, bounded } from "../shared/limits.js";
import { raw } from "./access.js";
import { storageId } from "./context.js";
/**
 * Remove one namespace's index of a shared extraction: the caller's thread
 * namespace by default. The extraction and every other namespace's index
 * stay. Use `purge` for storage cleanup.
 */
export async function release(runtime, ctx, args) {
    const namespace = bounded(args.namespace ?? args.threadId);
    const row = await raw(runtime, ctx, args, "release", namespace);
    const released = await ctx.runMutation(runtime.component.indexing.release, {
        artifactId: row._id,
        namespace,
    });
    if (!released)
        return null;
    // Exact-id native deletion, then drop the fenced record. A crash between
    // the two leaves a `released` record whose entry id is still known, so a
    // repeated release (or a later index admission) finishes the cleanup.
    if (released.entryId && runtime.rag) {
        const entry = { entryId: released.entryId };
        if (await runtime.rag.getEntry(ctx, entry))
            await runtime.rag.delete(ctx, entry);
    }
    await ctx.runMutation(runtime.component.indexing.forget, released);
    return null;
}
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
export async function purge(runtime, ctx, args) {
    bounded(args.fileId);
    let budget = LIMITS.purgeBatch;
    let more = false;
    let after = 0;
    walk: do {
        const page = await ctx.runMutation(runtime.component.artifacts.purge, { fileId: args.fileId, after });
        for (const id of page.storageIds)
            await ctx.storage.delete(storageId(id));
        if (runtime.rag) {
            for (const artifactId of page.artifactIds) {
                for (;;) {
                    if (budget === 0) {
                        more = true;
                        break walk;
                    }
                    const batch = await ctx.runMutation(runtime.component.indexing.purgeBatch, {
                        artifactId,
                        limit: budget,
                    });
                    for (const released of batch.entries) {
                        if (released.entryId) {
                            const entry = { entryId: released.entryId };
                            if (await runtime.rag.getEntry(ctx, entry))
                                await runtime.rag.delete(ctx, entry);
                        }
                        await ctx.runMutation(runtime.component.indexing.forget, released);
                    }
                    budget -= batch.entries.length;
                    if (!batch.more)
                        break;
                }
            }
        }
        after = page.next;
    } while (after !== null);
    return { more };
}
