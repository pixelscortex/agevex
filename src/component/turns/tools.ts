/** Cheap, fenced local-tool progress. One assignment read and one patch per edge.
 * No input, native call id, capability or output is stored in these markers.
 */
import { getConvexSize, v } from "convex/values";
import { mutation } from "../_generated/server.js";
import { LIMITS } from "../limits.js";
import { RUN_LIMITS } from "../run-settings.js";
import { TREE_LIMITS } from "../run-tree-values.js";

export const mark = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    sliceId: v.optional(v.string()),
    key: v.string(),
    name: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);

    // Disarmed slices and stale turns may never restore a marker after finish,
    // approval pause, watchdog, cancellation, or a newer slice's claim.
    if (
      !row ||
      row.cancelled ||
      row.turnStatus !== "running" ||
      !row.watchdogId ||
      row.turnToken !== args.turnToken ||
      row.lastSlice !== args.sliceId
    )
      return null;

    if (
      !/^[a-f0-9]{64}$/.test(args.key) ||
      (args.name !== undefined &&
        (!args.name || new TextEncoder().encode(args.name).byteLength > TREE_LIMITS.toolNameBytes))
    )
      throw new Error("INVALID_TOOL_MARKER");

    const activeTools = (row.activeTools ?? []).filter((tool) => tool.key !== args.key);

    if (args.name !== undefined) activeTools.push({ key: args.key, name: args.name });

    if (activeTools.length > RUN_LIMITS.toolsPerSlice) throw new Error("TOOL_CALL_LIMIT");

    const next = { ...row, activeTools: activeTools.length ? activeTools : undefined };

    // Include UTF-8 JSON expansion as well as Convex value bytes. A marker must
    // never erode the <=34 KiB envelope relied on by every tree/cancel read.
    if (
      Math.max(getConvexSize(next), new TextEncoder().encode(JSON.stringify(next)).byteLength) >
      LIMITS.assignmentBytes
    )
      throw new Error("ASSIGNMENT_METADATA_TOO_LARGE");

    await ctx.db.patch("assignments", row._id, { activeTools: next.activeTools });

    return null;
  },
});
