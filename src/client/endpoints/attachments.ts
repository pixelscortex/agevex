// File attachments on `open` / `send`.
//
// `validateFiles` bounds the requested file list; `attachment` checks each file's
// grant (`files.attachments.owns`), native metadata and Convex storage size, and builds the
// native user message with file parts; `recordAttachments` binds the files to the saved message
// (`files.attachments.attach`). All of it runs in the request's transaction, before and after
// the native save, so ownership and byte checks precede any native refcount write.

import {
  createFunctionHandle,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { getConvexSize, type GenericId } from "convex/values";
import { LIMITS } from "../../component/limits.js";
import type { ManagedAgent } from "../types.js";
import type { EndpointContext } from "./access.js";

type MutationCtx = GenericMutationCtx<GenericDataModel>;

/** At most `LIMITS.filesPerMessage` distinct, bounded file ids; else `INVALID_FILES`. */
export function validateFiles(files: string[] = []) {
  if (
    files.length > LIMITS.filesPerMessage ||
    new Set(files).size !== files.length ||
    files.some((fileId) => !fileId || fileId.length > LIMITS.fileIdLength)
  )
    throw new Error("INVALID_FILES");
}

/**
 * Validate the subject's files and build the native message to save.
 *
 * Returns `{ rejected: true }` when the files' total storage size exceeds the
 * attachment byte limit; throws `FILE_FORBIDDEN` / `INVALID_FILE` for a file the
 * subject was not granted or whose metadata is missing or oversized.
 */
export async function attachment(
  ep: EndpointContext,
  ctx: MutationCtx,
  managed: ManagedAgent,
  subject: string,
  text: string,
  files: string[] = [],
) {
  validateFiles(files);
  const native = await createFunctionHandle(managed.component.files.get);
  const parts: import("ai").UserContent = [{ type: "text", text }];
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

    if (!file || getConvexSize(file) > LIMITS.fileMetadataBytes) throw new Error("INVALID_FILE");

    // Agent metadata has no size. Read actual Convex storage metadata, never
    // file content, before native saves/refcount writes in this transaction.
    const metadata = await ctx.db.system.get("_storage", file.storageId as GenericId<"_storage">);

    if (!metadata) throw new Error("INVALID_FILE");

    bytes += metadata.size;

    if (bytes > ep.limits.attachmentBytes) return { rejected: true as const };

    parts.push(await filePart(ctx, file));
  }

  return {
    native,
    message: { role: "user" as const, content: files.length ? parts : text },
    metadata: { fileIds: files },
  };
}

type NativeFile = {
  storageId: string;
  mediaType?: string;
  mimeType?: string;
  filename?: string;
};

/**
 * The native file part for one attachment.
 *
 * Agent getFile (vercel/client/files.ts:167-194) uses this exact native
 * metadata + storage URL shape. Read it once here, so ownership and byte
 * validation precede native refcount writes in this same transaction.
 */
async function filePart(ctx: MutationCtx, file: NativeFile) {
  const url = await ctx.storage.getUrl(file.storageId as GenericId<"_storage">);

  if (!url) throw new Error("INVALID_FILE");

  return {
    type: "file" as const,
    data: new URL(url),
    mediaType: file.mediaType ?? file.mimeType ?? "application/octet-stream",
    ...(file.filename ? { filename: file.filename } : {}),
  };
}

/** Bind the request's files to the saved message, when there are any. */
export async function recordAttachments(
  ep: EndpointContext,
  ctx: MutationCtx,
  native: string,
  files: string[] | undefined,
  subject: string,
  threadId: string,
  messageId: string,
) {
  if (files?.length)
    await ctx.runMutation(ep.component.files.attachments.attach, {
      native,
      files,
      subject,
      threadId,
      messageId,
    });
}
