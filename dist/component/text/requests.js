/** Transactional host requests. Existing receipts dedupe on-demand scheduling;
 * optimistic title versions make transport repeats and rename races explicit. */
import { v } from "convex/values";
import { mutation } from "../_generated/server.js";
import { LIMITS } from "../limits.js";
import { armPurge, findReceipt, newDoneReceipt } from "../receipts/records.js";
import { queueText } from "./jobs.js";
import { validText } from "./values.js";
export const response = v.object({ messageId: v.string(), replayed: v.boolean() });
/** No native message is created by renaming. messageId is the native thread id
 * in the spec's shared response receipt; version is the idempotency fence. */
export const rename = mutation({
    args: { assignmentId: v.id("assignments"), text: v.string(), expectedVersion: v.number() },
    returns: response,
    handler: async (ctx, args) => {
        if (!validText(args.text, "title") ||
            !Number.isSafeInteger(args.expectedVersion) ||
            args.expectedVersion < 0)
            throw new Error("INVALID_TITLE");
        const row = await ctx.db.get("assignments", args.assignmentId);
        if (!row || row.childRunId)
            throw new Error("FORBIDDEN");
        if ((row.titleVersion ?? 0) !== args.expectedVersion)
            throw new Error("VERSION_CONFLICT");
        await ctx.db.patch("assignments", row._id, {
            titleVersion: args.expectedVersion + 1,
            titleSource: "user",
        });
        return { messageId: row.threadId, replayed: false };
    },
});
/** Same key replays scheduling, including after a known failure. A fresh key
 * may request new work after failed or unknown outcomes; it never replays them. */
export const summarize = mutation({
    args: { assignmentId: v.id("assignments"), requestKey: v.string() },
    returns: v.object({ status: v.union(v.literal("queued"), v.literal("replayed")) }),
    handler: async (ctx, args) => {
        if (!args.requestKey || args.requestKey.length > LIMITS.requestKeyLength)
            throw new Error("INVALID_REQUEST_KEY");
        const row = await ctx.db.get("assignments", args.assignmentId);
        if (!row || row.childRunId || !row.textConfig?.summary)
            throw new Error("SUMMARY_DISABLED");
        const scope = `summary:${row._id}`;
        if (await findReceipt(ctx, scope, args.requestKey))
            return { status: "replayed" };
        if (row.cancelled)
            throw new Error("CANCELLED");
        // Before the first claim the reserved inbox head owns the accepted run.
        // One direct <=2 KiB read; never discover it by scanning messages.
        const head = !row.runId && row.inboxId ? await ctx.db.get("inbox", row.inboxId) : null;
        const runId = row.runId ?? head?.runId;
        if (!runId)
            throw new Error("NO_RUN");
        await queueText(ctx, row, "summary", runId, true);
        await armPurge(ctx);
        await ctx.db.insert("receipts", newDoneReceipt({
            scope,
            key: args.requestKey,
            fingerprint: row._id,
            result: { status: "queued" },
        }));
        return { status: "queued" };
    },
});
