/** Subject-authorized native thread titles. Agent owns the metadata. */
import { getThreadMetadata, updateThreadMetadata } from "@convex-dev/agent";
import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { validText } from "../../component/text/values.js";
import { ownedThread, type EndpointContext } from "./access.js";

const response = v.object({ messageId: v.string(), replayed: v.boolean() });

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
