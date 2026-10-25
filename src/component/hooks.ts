/**
 * Registered endpoints behind the host's turn hooks, notes and side reviews.
 * Entry file only: every handler delegates to a module in hooks/.
 *
 * - Notes (hooks/notes.ts): `addNote` queues a passive note for the next safe
 *   claim; `beforeTurnNote` saves one immediately when no approval results
 *   are outstanding; `cancelNotes` drops a cancelled epoch's unsaved bodies.
 * - Hook state (hooks/state.ts): `hookState` (model choice, completed-turn
 *   count) and `continueAdmission` (stage an afterTurn continuation).
 * - Model routing (hooks/routing.ts): `routing` and `completeRouting`.
 * - Side reviews (hooks/refs.ts): `reviewContext` / `reviewed` over the
 *   exact-message ring, and `capture` for host coordinator saves.
 * - `origins` (hooks/origins.ts) labels note/continue/result messages.
 * Tables: `assignments`, `inbox`, `runs`; reads `subagentRuns` for origins.
 */
import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server.js";
import { assignmentByThread } from "./queue/assignments.js";
import { markReviewed, messageRef, recordRefs, reviewWindow } from "./hooks/refs.js";
import { dropCancelledNotes, queueNote, saveBeforeTurnNote } from "./hooks/notes.js";
import { recordHookState, stageContinuation } from "./hooks/state.js";
import { completeRoutingFor, routingState } from "./hooks/routing.js";
import { messageOrigins } from "./hooks/origins.js";

/** Delete a cancelled epoch's unsaved note bodies; one finite job per
 * assignment, scheduled by queue.cancel. */
export const cancelNotes = internalMutation({
  args: { assignmentId: v.id("assignments"), epoch: v.number() },
  handler: (ctx, { assignmentId, epoch }) => dropCancelledNotes(ctx, assignmentId, epoch),
});

/** Label note, continuation and result messages on one reader page. */
export const origins = query({
  args: { assignmentId: v.id("assignments"), subject: v.string(), messageIds: v.array(v.string()) },
  handler: (ctx, args) => messageOrigins(ctx, args),
});

/** Record a beforeTurn model choice and/or a completed turn. */
export const hookState = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    model: v.optional(v.string()),
    complete: v.optional(v.boolean()),
  },
  handler: (ctx, args) => recordHookState(ctx, args),
});

/** Stage an afterTurn hook's continuation prompt for the next slice. */
export const continueAdmission = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    prompt: v.string(),
  },
  handler: (ctx, args) => stageContinuation(ctx, args),
});

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

/** Queue a note for the next safe claim; see hooks/notes.ts. */
export const addNote = mutation({
  args: {
    assignmentId: v.id("assignments"),
    text: v.string(),
    from: v.string(),
  },
  returns: v.boolean(),
  handler: (ctx, args): Promise<boolean> => queueNote(ctx, args),
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

/** Whether the run's routing decision for this agent is still pending. */
export const routing = query({
  args: { assignmentId: v.id("assignments"), agentIndex: v.number() },
  handler: (ctx, args) => routingState(ctx, args),
});

/** The routing owner finished its decision: release routing ownership. */
export const completeRouting = mutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string(), agentIndex: v.number() },
  returns: v.null(),
  handler: (ctx, args) => completeRoutingFor(ctx, args),
});

/** Save a beforeTurn note now, or queue it behind outstanding approval
 * results; see hooks/notes.ts. */
export const beforeTurnNote = mutation({
  args: {
    assignmentId: v.id("assignments"),
    text: v.string(),
    from: v.string(),
    addMessages: v.string(),
    getMessages: v.string(),
  },
  handler: (ctx, args) => saveBeforeTurnNote(ctx, args),
});
