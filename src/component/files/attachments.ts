/**
 * Attachment attestations in the `receipts` table (`kind: "attachment"`):
 * upload grants and message bindings.
 *
 * Two row shapes share one kind: an upload *grant* (no `threadId`) proves a
 * subject uploaded a native file, written by the host's trusted upload
 * transaction (`register`); a message *binding* (with `threadId` and
 * `messageId`) records that a file was attached to one exact native message,
 * written atomically with that message (`attach` -> `bindFiles`). The host
 * checks `owns` / `forMessage` before a model reads an attachment. All reads
 * are exact `by_file` / `by_message` lookups capped at
 * `LIMITS.filesPerMessage`. Native Agent still owns file bytes and metadata.
 */
import { type MutationCtx, type QueryCtx, mutation, query } from "../_generated/server.js";
import { assertFact } from "../facts.js";
import { LIMITS } from "../limits.js";
import { v } from "convex/values";

/** File and message ids are bounded opaque identities. */
export function assertFileIdentity(value: string) {
  if (!value || value.length > LIMITS.fileIdLength) throw new Error("INVALID_FILE_IDENTITY");
}

/** The native component handle namespaces every file id. */
export function assertNativeHandle(value: string) {
  if (!value || value.length > LIMITS.functionHandleLength)
    throw new Error("INVALID_NATIVE_HANDLE");
}

/** The subject's upload grant for one native file, or null. */
export function uploadGrant(
  ctx: Pick<QueryCtx, "db">,
  native: string,
  fileId: string,
  subject: string,
) {
  return ctx.db
    .query("receipts")
    .withIndex("by_file", (q) =>
      q.eq("native", native).eq("fileId", fileId).eq("subject", subject).eq("threadId", undefined),
    )
    .unique();
}

/** Every binding of one native message (never more than filesPerMessage). */
export function messageBindings(ctx: Pick<QueryCtx, "db">, native: string, messageId: string) {
  return ctx.db
    .query("receipts")
    .withIndex("by_message", (q) => q.eq("native", native).eq("messageId", messageId))
    .take(LIMITS.filesPerMessage);
}

/** Bind granted files to one native message in the transaction that saves
 * it. Refuses more than `filesPerMessage` bindings per message (across
 * repeated calls) and any file the subject holds no grant for; re-binding an
 * already bound file is a no-op. */
export async function bindFiles(
  ctx: MutationCtx,
  args: { native: string; files: string[]; subject: string; threadId: string; messageId: string },
) {
  assertNativeHandle(args.native);
  assertFact(args.subject, "subject");
  assertFact(args.threadId, "threadId");
  assertFileIdentity(args.messageId);
  if (args.files.length > LIMITS.filesPerMessage || new Set(args.files).size !== args.files.length)
    throw new Error("FILE_LIMIT");
  for (const fileId of args.files) assertFileIdentity(fileId);

  // At most eight grants + eight message bindings, all <=8 KiB, and
  // <=8 writes. No file content or native transcript read.
  const existing = await messageBindings(ctx, args.native, args.messageId);
  const bound = (fileId: string) =>
    existing.some(
      (row) => row.kind === "attachment" && row.fileId === fileId && row.native === args.native,
    );
  // Keep every message at <=filesPerMessage bindings, including across
  // repeated host calls for one message. By induction the take above then
  // sees every existing binding (so dedup is exact) and forMessage's take of
  // the same size never truncates.
  const added = args.files.filter((fileId) => !bound(fileId));
  if (existing.length + added.length > LIMITS.filesPerMessage) throw new Error("FILE_LIMIT");

  for (const fileId of args.files) {
    const grant = await uploadGrant(ctx, args.native, fileId, args.subject);
    if (!grant || grant.kind !== "attachment") throw new Error("FILE_FORBIDDEN");
    // A separate row per message retains exact ids for durable extraction
    // admission even when the same file is attached in a later request.
    if (!bound(fileId))
      await ctx.db.insert("receipts", {
        kind: "attachment",
        native: args.native,
        fileId,
        subject: args.subject,
        threadId: args.threadId,
        messageId: args.messageId,
      });
  }
  return null;
}

/** Host-only upload attestation, not a browser endpoint. The host must call
 * this from its trusted upload transaction, never expose arbitrary file ids as
 * proof of ownership. Agent 0.7.7 files.ts:22-83 has hash dedup but no subject. */
export const register = mutation({
  args: { native: v.string(), fileId: v.string(), subject: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertFileIdentity(args.fileId);
    assertFact(args.subject, "subject");
    assertNativeHandle(args.native);

    const row = await uploadGrant(ctx, args.native, args.fileId, args.subject);
    if (!row) await ctx.db.insert("receipts", { kind: "attachment", ...args });
    return null;
  },
});

/** Whether the subject holds a grant (no `threadId`) or a binding in that
 * thread for one native file. */
export const owns = query({
  args: {
    native: v.string(),
    fileId: v.string(),
    subject: v.string(),
    threadId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    assertNativeHandle(args.native);
    assertFileIdentity(args.fileId);
    assertFact(args.subject, "subject");
    if (args.threadId !== undefined) assertFact(args.threadId, "threadId");

    return !!(await ctx.db
      .query("receipts")
      .withIndex("by_file", (q) =>
        q
          .eq("native", args.native)
          .eq("fileId", args.fileId)
          .eq("subject", args.subject)
          .eq("threadId", args.threadId),
      )
      .first());
  },
});

/** Bind granted files to one native message; see `bindFiles`. */
export const attach = mutation({
  args: {
    native: v.string(),
    files: v.array(v.string()),
    subject: v.string(),
    threadId: v.string(),
    messageId: v.string(),
  },
  returns: v.null(),
  handler: (ctx, args) => bindFiles(ctx, args),
});

/** The file ids bound to one message of this subject's thread. */
export const forMessage = query({
  args: { messageId: v.string(), subject: v.string(), threadId: v.string(), native: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    assertNativeHandle(args.native);
    assertFact(args.subject, "subject");
    assertFact(args.threadId, "threadId");
    assertFileIdentity(args.messageId);

    const rows = await messageBindings(ctx, args.native, args.messageId);
    return rows.flatMap((row) =>
      row.kind === "attachment" && row.subject === args.subject && row.threadId === args.threadId
        ? [row.fileId]
        : [],
    );
  },
});
