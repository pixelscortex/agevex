/** Subject-authorized root metadata endpoints. Native Agent owns title text;
 * core owns its rename fence and the bounded summary coverage metadata. */
import { getThreadMetadata, updateThreadMetadata } from "@convex-dev/agent";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { response } from "../../component/text/requests.js";
import { validText } from "../../component/text/values.js";
import { ownedThread } from "./access.js";
/** Subscribe to the native title and its optimistic rename version. */
export function titleEndpoint(ep) {
    return queryGeneric({
        args: { threadId: v.string() },
        returns: v.object({
            text: v.union(v.null(), v.string()),
            source: v.union(v.null(), v.literal("auto"), v.literal("user")),
            version: v.number(),
        }),
        handler: async (ctx, args) => {
            const row = await ownedThread(ep, ctx, args.threadId, "title");
            const state = await ctx.runQuery(ep.component.text.state.view, {
                assignmentId: row.assignmentId,
            });
            const native = await getThreadMetadata(ctx, row.native.component, args);
            return {
                text: native.title ?? null,
                source: state.source ?? (native.title !== undefined ? "user" : null),
                version: state.version,
            };
        },
    });
}
/** Repeated identical renames replay once; conflicting versions never overwrite. */
export function renameEndpoint(ep) {
    return mutationGeneric({
        args: { threadId: v.string(), text: v.string(), expectedVersion: v.number() },
        returns: response,
        handler: async (ctx, args) => {
            const row = await ownedThread(ep, ctx, args.threadId, "rename");
            if (!validText(args.text, "title") ||
                !Number.isSafeInteger(args.expectedVersion) ||
                args.expectedVersion < 0)
                throw new Error("INVALID_TITLE");
            const state = await ctx.runQuery(ep.component.text.state.view, {
                assignmentId: row.assignmentId,
            });
            const native = await getThreadMetadata(ctx, row.native.component, {
                threadId: args.threadId,
            });
            if (state.version === args.expectedVersion + 1 &&
                state.source === "user" &&
                native.title === args.text)
                return { messageId: args.threadId, replayed: true };
            const result = await ctx.runMutation(ep.component.text.requests.rename, {
                assignmentId: row.assignmentId,
                text: args.text,
                expectedVersion: args.expectedVersion,
            });
            await updateThreadMetadata(ctx, row.native.component, {
                threadId: args.threadId,
                patch: { title: args.text },
            });
            return result;
        },
    });
}
/** Summary text is display-only; native context remains unchanged. */
export function summaryEndpoint(ep) {
    return queryGeneric({
        args: { threadId: v.string() },
        returns: v.union(v.null(), v.object({ text: v.string(), throughMessageId: v.string() })),
        handler: async (ctx, args) => {
            const row = await ownedThread(ep, ctx, args.threadId, "summary");
            const state = await ctx.runQuery(ep.component.text.state.view, {
                assignmentId: row.assignmentId,
            });
            return state.summary
                ? { text: state.summary.text, throughMessageId: state.summary.through.id }
                : null;
        },
    });
}
/** Explicit request keys dedupe queued work; no action waits for the model. */
export function summarizeEndpoint(ep) {
    return mutationGeneric({
        args: { threadId: v.string(), requestKey: v.string() },
        returns: v.object({ status: v.union(v.literal("queued"), v.literal("replayed")) }),
        handler: async (ctx, args) => {
            const row = await ownedThread(ep, ctx, args.threadId, "summarize");
            if (!ep.config.summary)
                throw new Error("SUMMARY_DISABLED");
            return ctx.runMutation(ep.component.text.requests.summarize, {
                assignmentId: row.assignmentId,
                requestKey: args.requestKey,
            });
        },
    });
}
