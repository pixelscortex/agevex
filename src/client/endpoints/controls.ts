// Public endpoints that resolve or stop work in an owned thread.
//
// `respond` resolves a recorded tool approval (`queue.respond`), `answer` answers
// a recorded deferred tool call (`queue.answer`), and `cancel` cancels the
// thread's current request (`queue.cancel`). Each runs the `ownedThread` gate
// first; `respond` and `answer` also work on child threads the subject owns.

import { createFunctionHandle, mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { ownedThread, type EndpointContext } from "./access.js";

/** `respond`: approve or deny one recorded approval request. Idempotent (`replayed`). */
export function respondEndpoint(ep: EndpointContext) {
  return mutationGeneric({
    args: {
      threadId: v.string(),
      approvalId: v.string(),
      approved: v.boolean(),
      reason: v.optional(v.string()),
    },
    returns: v.object({ messageId: v.string(), replayed: v.boolean() }),
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "respond");
      return ctx.runMutation(ep.component.queue.respond, {
        assignmentId: row.assignmentId,
        subject: row.subject,
        approvalId: args.approvalId,
        approved: args.approved,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        addMessages: await createFunctionHandle(row.native.component.messages.addMessages),
      });
    },
  });
}

/** `answer`: supply the result of one recorded deferred tool call. Idempotent (`replayed`). */
export function answerEndpoint(ep: EndpointContext) {
  return mutationGeneric({
    args: { threadId: v.string(), toolCallId: v.string(), text: v.string() },
    returns: v.object({ messageId: v.string(), replayed: v.boolean() }),
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "answer");
      return ctx.runMutation(ep.component.queue.answer, {
        assignmentId: row.assignmentId,
        subject: row.subject,
        toolCallId: args.toolCallId,
        text: args.text,
      });
    },
  });
}

/** `cancel`: cancel the owned root thread's current request. */
export function cancelEndpoint(ep: EndpointContext) {
  return mutationGeneric({
    args: { threadId: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "cancel");
      await ctx.runMutation(ep.component.queue.cancel, {
        assignmentId: row.assignmentId,
        subject: row.subject,
      });
      return null;
    },
  });
}
