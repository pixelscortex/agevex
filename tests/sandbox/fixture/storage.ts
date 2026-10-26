/** convex-test 0.0.61 omits storageGetMetadata; use its real system metadata for that one syscall. */
import { internalQueryGeneric, makeFunctionReference } from "convex/server";
import { v, type GenericId } from "convex/values";
import type { SandboxContext } from "../../../src/modules/sandbox/client/types.js";

export const metadata = internalQueryGeneric({
  args: { storageId: v.id("_storage") },
  handler: (ctx, { storageId }) => ctx.db.system.get("_storage", storageId),
});

/** Keep size checks real and bounded; never read a Blob to simulate metadata. */
export function installStorageMetadata(ctx: SandboxContext) {
  ctx.storage.getMetadata = (async (storageId: GenericId<"_storage">) => {
    const row = await ctx.runQuery(
      makeFunctionReference<
        "query",
        { storageId: typeof storageId },
        { size: number; sha256: string; contentType?: string } | null
      >("storage:metadata"),
      { storageId },
    );

    return row
      ? { storageId, size: row.size, sha256: row.sha256, contentType: row.contentType ?? null }
      : null;
  }) as SandboxContext["storage"]["getMetadata"];
}
