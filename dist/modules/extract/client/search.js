/**
 * Bounded RAG retrieval with current attachment and index checks.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { LIMITS, bounded, integer, sliceText, utf8 } from "../shared/limits.js";
import { authorize } from "./access.js";
import { subjectOf } from "./context.js";
/** Search bounded native chunks, then recheck each hit against its current attachment and index. */
export async function search(runtime, ctx, args) {
    if (!runtime.rag)
        throw new Error("EXTRACT_RAG_DISABLED");
    bounded(args.query, LIMITS.queryBytes);
    const limit = integer(args.limit ?? LIMITS.searchResults, LIMITS.searchResults, 1);
    await authorize(runtime, ctx, {
        operation: "search",
        threadId: args.threadId,
        namespace: args.namespace,
        ...subjectOf(args),
    });
    // RAG 0.7.8 src/client/index.ts:368 owns retrieval. No adjacent context:
    // <=10 hits * <=8 KiB own chunks = <=80 KiB upstream text; final tool text
    // <=64 KiB. Use a dedicated RAG mount/namespace for these bounded chunks.
    const result = await runtime.rag.search(ctx, {
        namespace: args.namespace,
        query: args.query,
        limit,
        chunkContext: { before: 0, after: 0 },
    });
    const references = [];
    let text = "";
    for (const entry of result.entries.slice(0, limit)) {
        const artifactId = entry.metadata?.artifactId;
        const fileId = entry.metadata?.fileId;
        if (typeof artifactId !== "string" || typeof fileId !== "string")
            continue;
        // A hit whose file is no longer attached (or whose extraction is gone)
        // is skipped, not an error: one stale entry must not fail the whole
        // search and hide the still-attached results.
        try {
            const row = await ctx.runQuery(runtime.component.artifacts.get, { artifactId });
            if (!row || row.status !== "ready" || row.fileId !== fileId)
                continue;
            await authorize(runtime, ctx, {
                operation: "search",
                threadId: args.threadId,
                fileId: row.fileId,
                namespace: args.namespace,
                ...subjectOf(args),
            });
            const index = await ctx.runQuery(runtime.component.indexing.lookup, {
                artifactId: row._id,
                namespace: args.namespace,
            });
            if (index?.status !== "ready" || index.entryId !== entry.entryId)
                continue;
        }
        catch {
            continue;
        }
        const remaining = LIMITS.toolBytes - utf8(text).length;
        if (!remaining)
            break;
        text += sliceText((text ? "\n" : "") + entry.text, remaining);
        references.push({ artifactId, fileId });
    }
    return { text, references, usage: result.usage };
}
