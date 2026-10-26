/**
 * Registered public delegation reads for a root thread's owner:
 * `delegations` (the root's paginated history, newest first) and `runTree`
 * (the current request's delegation tree). Both authorize the subject on the
 * root assignment and project through subagents/views.ts. Reads
 * `assignments` and `subagentRuns`.
 */
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "../_generated/server.js";
import { subagentRun, vPaginationResult } from "../schema.js";
import { assignmentByThread } from "../turns/assignments.js";
import { delegationPage } from "./views.js";
import { requestTree } from "./tree.js";
import { runTree as treeValue } from "../run-tree-values.js";

/** The root thread's delegation history, newest first. */
export const delegations = query({
  args: { threadId: v.string(), subject: v.string(), paginationOpts: paginationOptsValidator },
  returns: vPaginationResult(subagentRun),
  handler: async (ctx, args) => {
    const root = await assignmentByThread(ctx, args.threadId);

    if (!root || root.subject !== args.subject) throw new Error("FORBIDDEN");

    return delegationPage(ctx, root, args.paginationOpts);
  },
});

/** The current root request's delegation tree; see subagents/views.ts. */
export const runTree = query({
  args: { threadId: v.string(), subject: v.string(), rootRunId: v.optional(v.string()) },
  returns: treeValue,
  handler: async (ctx, args) => {
    const root = await assignmentByThread(ctx, args.threadId);

    if (!root || root.subject !== args.subject || root.childRunId) throw new Error("FORBIDDEN");

    return requestTree(ctx, root, args.rootRunId);
  },
});
