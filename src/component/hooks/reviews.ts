/**
 * Registered side-review endpoints over the exact-message ring
 * (hooks/refs.ts): `reviewContext` (the refs a side reviewer should read now,
 * or null if not due), `reviewed` (record its consumed boundary) and
 * `capture` (record host coordinator saves that bypass the native-save
 * fence). Touches `assignments.contextMessages` and review boundaries.
 */
import { v } from "convex/values";
import { mutation, query } from "../_generated/server.js";
import { assignmentByThread } from "../turns/assignments.js";
import { markReviewed, messageRef, recordRefs, reviewWindow } from "./refs.js";

/** The message refs a side reviewer should read now, or null if not due. */
export const reviewContext = query({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    agent: v.string(),
    turns: v.optional(v.number()),
    minutes: v.optional(v.number()),
  },
  handler: (ctx, args) => reviewWindow(ctx, args),
});

/** Record a side reviewer's consumed boundary. */
export const reviewed = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    agent: v.string(),
    boundary: v.number(),
  },
  returns: v.null(),
  handler: (ctx, args) => markReviewed(ctx, args),
});

/** Host coordinator saves (results, questions and follow-ups) do not pass
 * through the action's native-save fence. Capture their identities inside that
 * same host mutation too, so delta never omits a non-model message. */
export const capture = mutation({
  args: { threadId: v.string(), savedMessage: messageRef },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await assignmentByThread(ctx, args.threadId);
    if (row) await recordRefs(ctx, row, [args.savedMessage]);
    return null;
  },
});
