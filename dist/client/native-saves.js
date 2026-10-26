// Native Agent message saves whose exact identity the component records.
//
// Rule: no transcript scans. Whenever the runtime saves a native message the
// component must later find again (a prompt, a delivered result, a review delta),
// it records the saved message's id, order and size in the same transaction as
// the save. `savedMessageRef` builds that record; `saveTrackedMessage` saves and,
// when reviews or summaries watch this registration, captures it through `hooks.reviews.capture`.
// Used by the public endpoints, the coordinator and delivery.
import { saveMessage } from "@convex-dev/agent";
import { getConvexSize } from "convex/values";
/**
 * The exact identity of one native save, as the component stores it.
 * `bytes` is the saved document's Convex size, so review-delta reads can be
 * bounded by bytes without loading the message.
 */
export function savedMessageRef(messageId, message) {
    return {
        id: messageId,
        order: message.order,
        stepOrder: message.stepOrder,
        bytes: getConvexSize(message),
    };
}
/**
 * Save one native message and, when reviews or summaries are enabled, capture its exact
 * identity for that thread's review delta in the same transaction.
 *
 * Without reviews or summaries nothing reads the capture, so it is skipped entirely.
 */
export async function saveTrackedMessage(rt, ctx, native, args) {
    const saved = await saveMessage(ctx, native, args);
    if (rt.watching)
        await ctx.runMutation(rt.component.hooks.reviews.capture, {
            threadId: args.threadId,
            savedMessage: savedMessageRef(saved.messageId, saved.message),
        });
    return saved;
}
