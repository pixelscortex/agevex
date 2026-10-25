/**
 * Registered attachment endpoints: upload grants and message bindings.
 * Entry file only: the attestation rows and their bounded lookups live in
 * files/grants.ts.
 *
 * The host `register`s a grant from its trusted upload transaction, `attach`es
 * granted files to a native message in the transaction that saves it, and
 * checks `owns` / `forMessage` before a model reads an attachment. Table:
 * `receipts` (`kind: "attachment"`).
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { assertFact } from "./facts.js";
import {
  assertFileIdentity,
  assertNativeHandle,
  bindFiles,
  messageBindings,
  uploadGrant,
} from "./files/grants.js";

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

/** Bind granted files to one native message; see files/grants.ts. */
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
