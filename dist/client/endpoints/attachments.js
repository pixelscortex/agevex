// File attachments on `open` / `send`.
//
// `validateFiles` bounds the requested file list; `attachment` checks each file's
// grant (`files.attachments.owns`), native metadata and Convex storage size, and builds the
// native user message (file parts, or a text pointer when the extract slot reads
// files instead); `recordAttachments` binds the files to the saved message
// (`files.attachments.attach`). All of it runs in the request's transaction, before and after
// the native save, so ownership and byte checks precede any native refcount write.
import { createFunctionHandle, } from "convex/server";
import { getConvexSize } from "convex/values";
import { LIMITS } from "../../component/limits.js";
/** At most `LIMITS.filesPerMessage` distinct, bounded file ids; else `INVALID_FILES`. */
export function validateFiles(files = []) {
    if (files.length > LIMITS.filesPerMessage ||
        new Set(files).size !== files.length ||
        files.some((fileId) => !fileId || fileId.length > LIMITS.fileIdLength))
        throw new Error("INVALID_FILES");
}
/**
 * Validate the subject's files and build the native message to save.
 *
 * Returns `{ rejected: true }` when the files' total storage size exceeds the
 * attachment byte limit; throws `FILE_FORBIDDEN` / `INVALID_FILE` for a file the
 * subject was not granted or whose metadata is missing or oversized.
 */
export async function attachment(ep, ctx, managed, subject, text, files = []) {
    validateFiles(files);
    const native = await createFunctionHandle(managed.component.files.get);
    const parts = [{ type: "text", text }];
    // At the hard maximum: eight <=4 KiB native file metadata rows, eight
    // <=1 KiB storage metadata rows and eight <=8 KiB grants. An invalid oversized native row aborts immediately after
    // at most one <=1 MiB read, before any native write. Native attachment saves
    // reread <=8*4 KiB for refcounts; total attachment-specific admission <1 MiB plus
    // existing turn/Workflow bookkeeping. Storage holds all actual file bytes.
    let bytes = 0;
    for (const fileId of files) {
        if (!(await ctx.runQuery(ep.component.files.attachments.owns, { native, fileId, subject })))
            throw new Error("FILE_FORBIDDEN");
        const file = await ctx.runQuery(managed.component.files.get, { fileId });
        if (!file || getConvexSize(file) > LIMITS.fileMetadataBytes)
            throw new Error("INVALID_FILE");
        // Agent metadata has no size. Read actual Convex storage metadata, never
        // file content, before native saves/refcount writes in this transaction.
        const metadata = await ctx.db.system.get("_storage", file.storageId);
        if (!metadata)
            throw new Error("INVALID_FILE");
        bytes += metadata.size;
        if (bytes > ep.limits.attachmentBytes)
            return { rejected: true };
        if (!ep.config.extract)
            parts.push(await filePart(ctx, file));
    }
    if (ep.config.extract && files.length)
        parts.push({
            type: "text",
            text: `Attached files: ${files.join(", ")}. Use read_file or search_files to inspect them.`,
        });
    return {
        native,
        message: { role: "user", content: files.length ? parts : text },
        metadata: { fileIds: files },
    };
}
/**
 * The native file part for one attachment.
 *
 * Agent getFile (vercel/client/files.ts:167-194) uses this exact native
 * metadata + storage URL shape. Read it once here, so ownership and byte
 * validation precede native refcount writes in this same transaction.
 */
async function filePart(ctx, file) {
    const url = await ctx.storage.getUrl(file.storageId);
    if (!url)
        throw new Error("INVALID_FILE");
    return {
        type: "file",
        data: new URL(url),
        mediaType: file.mediaType ?? file.mimeType ?? "application/octet-stream",
        ...(file.filename ? { filename: file.filename } : {}),
    };
}
/** Bind the request's files to the saved message, when there are any. */
export async function recordAttachments(ep, ctx, native, files, subject, threadId, messageId) {
    if (files?.length)
        await ctx.runMutation(ep.component.files.attachments.attach, {
            native,
            files,
            subject,
            threadId,
            messageId,
        });
}
