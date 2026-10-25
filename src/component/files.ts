import { assertFact } from "./facts.js";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { LIMITS } from "./limits.js";

function identity(value: string) {
  if (!value || value.length > LIMITS.fileIdLength) throw new Error("INVALID_FILE_IDENTITY");
}
function nativeIdentity(value: string) {
  if (!value || value.length > LIMITS.functionHandleLength)
    throw new Error("INVALID_NATIVE_HANDLE");
}
/** Host-only upload attestation, not a browser endpoint. The host must call
 * this from its trusted upload transaction, never expose arbitrary file ids as
 * proof of ownership. Agent 0.7.7 files.ts:22-83 has hash dedup but no subject. */
export const register = mutation({
  args: { native: v.string(), fileId: v.string(), subject: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    identity(args.fileId);
    assertFact(args.subject, "subject");
    nativeIdentity(args.native);
    const row = await ctx.db
      .query("receipts")
      .withIndex("by_file", (q) =>
        q
          .eq("native", args.native)
          .eq("fileId", args.fileId)
          .eq("subject", args.subject)
          .eq("threadId", undefined),
      )
      .unique();
    if (!row) await ctx.db.insert("receipts", { kind: "attachment", ...args });
    return null;
  },
});
export const owns = query({
  args: {
    native: v.string(),
    fileId: v.string(),
    subject: v.string(),
    threadId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    nativeIdentity(args.native);
    identity(args.fileId);
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
export const attach = mutation({
  args: {
    native: v.string(),
    files: v.array(v.string()),
    subject: v.string(),
    threadId: v.string(),
    messageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    nativeIdentity(args.native);
    assertFact(args.subject, "subject");
    assertFact(args.threadId, "threadId");
    identity(args.messageId);
    if (
      args.files.length > LIMITS.filesPerMessage ||
      new Set(args.files).size !== args.files.length
    )
      throw new Error("FILE_LIMIT");
    for (const fileId of args.files) identity(fileId);
    // At most eight grants + eight message bindings, all <=8 KiB, and
    // <=8 writes. No file content or native transcript read.
    const existing = await ctx.db
      .query("receipts")
      .withIndex("by_message", (q) => q.eq("native", args.native).eq("messageId", args.messageId))
      .take(LIMITS.filesPerMessage);
    // Keep every message at <=filesPerMessage bindings, including across
    // repeated host calls for one message. By induction the take above then
    // sees every existing binding (so dedup is exact) and forMessage's take of
    // the same size never truncates.
    const added = args.files.filter(
      (fileId) =>
        !existing.some(
          (row) => row.kind === "attachment" && row.fileId === fileId && row.native === args.native,
        ),
    );
    if (existing.length + added.length > LIMITS.filesPerMessage) throw new Error("FILE_LIMIT");
    for (const fileId of args.files) {
      const grant = await ctx.db
        .query("receipts")
        .withIndex("by_file", (q) =>
          q
            .eq("native", args.native)
            .eq("fileId", fileId)
            .eq("subject", args.subject)
            .eq("threadId", undefined),
        )
        .unique();
      if (!grant || grant.kind !== "attachment") throw new Error("FILE_FORBIDDEN");
      // A separate row per message retains exact ids for durable extraction
      // admission even when the same file is attached in a later request.
      if (
        !existing.some(
          (row) => row.kind === "attachment" && row.fileId === fileId && row.native === args.native,
        )
      )
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
  },
});
export const forMessage = query({
  args: { messageId: v.string(), subject: v.string(), threadId: v.string(), native: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    nativeIdentity(args.native);
    assertFact(args.subject, "subject");
    assertFact(args.threadId, "threadId");
    identity(args.messageId);
    const rows = await ctx.db
      .query("receipts")
      .withIndex("by_message", (q) => q.eq("native", args.native).eq("messageId", args.messageId))
      .take(LIMITS.filesPerMessage);
    return rows.flatMap((row) =>
      row.kind === "attachment" && row.subject === args.subject && row.threadId === args.threadId
        ? [row.fileId]
        : [],
    );
  },
});
