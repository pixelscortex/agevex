/**
 * Host-side internal action and storage-metadata registrations.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { internalActionGeneric, internalQueryGeneric } from "convex/server";
import { v } from "convex/values";
import { storageId, type RuntimeContext } from "./context.js";
import { execute } from "./execute.js";
/** Register the internal worker and exact storage-size query without admitting paid work. */
export function internalFunctions(runtime: RuntimeContext) {
  return {
    storageMetadata: internalQueryGeneric({
      args: { storageId: v.string() },
      returns: v.union(v.null(), v.object({ size: v.number() })),
      handler: async (ctx, args) => {
        const meta = await ctx.db.system.get("_storage", storageId(args.storageId));

        return meta ? { size: meta.size } : null;
      },
    }),
    execute: internalActionGeneric({
      args: {
        artifactId: v.string(),
        attempt: v.number(),
        claim: v.string(),
        threadId: v.string(),
        subject: v.optional(v.string()),
      },
      returns: v.null(),
      handler: (ctx, args) => execute(runtime, ctx, args),
    }),
  };
}
