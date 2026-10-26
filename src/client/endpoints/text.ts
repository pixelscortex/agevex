/** Subject-authorized native thread metadata. The Agent component owns title
 * and summary content; agevex only authorizes explicit summary scheduling. */
import { getThreadMetadata, updateThreadMetadata } from "@convex-dev/agent";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { response } from "../../component/text/requests.js";
import { validText } from "../../component/text/values.js";
import { ownedThread, type EndpointContext } from "./access.js";

/** Subscribe to the native thread title. */
export function titleEndpoint(ep: EndpointContext) {
  return queryGeneric({
    args: { threadId: v.string() },
    returns: v.object({ text: v.union(v.null(), v.string()) }),
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "title");
      const native = await getThreadMetadata(ctx, row.native.component, args);

      return { text: native.title ?? null };
    },
  });
}

/** The native title itself is the rename state. Repeated identical writes are
 * harmless, and an automatic title's atomic native check always respects it. */
export function renameEndpoint(ep: EndpointContext) {
  return mutationGeneric({
    args: { threadId: v.string(), text: v.string() },
    returns: response,
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "rename");

      if (!validText(args.text, "title")) throw new Error("INVALID_TITLE");

      const native = await getThreadMetadata(ctx, row.native.component, {
        threadId: args.threadId,
      });

      const replayed = native.title === args.text;

      if (!replayed)
        await updateThreadMetadata(ctx, row.native.component, {
          threadId: args.threadId,
          patch: { title: args.text },
        });

      return { messageId: args.threadId, replayed };
    },
  });
}

/** Read the native summary field; no separate coverage/version store exists. */
export function summaryEndpoint(ep: EndpointContext) {
  return queryGeneric({
    args: { threadId: v.string() },
    returns: v.union(v.null(), v.object({ text: v.string() })),
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "summary");
      const native = await getThreadMetadata(ctx, row.native.component, args);

      return native.summary === undefined ? null : { text: native.summary };
    },
  });
}

/** Explicit request keys dedupe scheduling, including unknown paid outcomes. */
export function summarizeEndpoint(ep: EndpointContext) {
  return mutationGeneric({
    args: { threadId: v.string(), requestKey: v.string() },
    returns: v.object({ status: v.union(v.literal("queued"), v.literal("replayed")) }),
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "summarize");

      if (!ep.config.summary) throw new Error("SUMMARY_DISABLED");

      return ctx.runMutation(ep.component.text.requests.summarize, {
        assignmentId: row.assignmentId,
        requestKey: args.requestKey,
      });
    },
  });
}
