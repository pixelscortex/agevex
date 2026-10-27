/**
 * Non-blocking child progress: a native parent note, ready inbox reference,
 * hop spend, final-result hop reservations, lifetime/rate counters and replay
 * receipt commit atomically.
 * No text is copied into coordination rows. Replays check live fences first,
 * then bypass fresh-note limits without re-enqueueing or ringing the loop.
 */
import { getConvexSize, type ObjectType, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server.js";
import { LIMITS } from "../limits.js";
import { armPurge, findReceipt, newDoneReceipt } from "../receipts/records.js";
import { interaction, interactionResult, interactionTarget, post } from "./messages.js";

const noteArgs = {
  assignmentId: v.id("assignments"),
  turnToken: v.string(),
  key: v.string(),
  fingerprint: v.string(),
  text: v.string(),
};

type NoteArgs = ObjectType<typeof noteArgs>;
const accepted = v.object({ status: v.literal("accepted"), messageId: v.string() });
const replay = v.object({ kind: v.literal("replay"), messageId: v.string() });

/** Check encoded text size before native saving, including JSON escaping overhead. */
export function parentNoteFits(text: string) {
  return (
    !!text.trim() &&
    text.length <= LIMITS.parentNoteBytes &&
    Math.max(getConvexSize(text), new TextEncoder().encode(JSON.stringify(text)).length) <=
      LIMITS.parentNoteBytes
  );
}

/** Constant-size live admission and exact receipt lookup; never read native history.
 * Four <=16 KiB assignment reads (three distinct rows), one <=4 KiB child
 * and one <=16 KiB budget, repeated <=5 times across preflight and commit:
 * 5*84 KiB=420 KiB. Receipts (<=1 KiB each), patches and the <=64 KiB
 * expiry-head receipt probe keep admission metadata below 1 MiB.
 * The host's one native save reads <=1 MiB tail (Agent messages.ts:298-322).
 * post/wake adds only bounded inbox and scheduling metadata; combined <4 MiB.
 * Including the hop reservation scan (headroom.ts), the whole host
 * transaction stays below 8 MiB /1,000 reads /128 writes. Notes require
 * queuedMessages < queueLength; owed final results may exceed that limit.
 */
async function context(ctx: QueryCtx | MutationCtx, args: NoteArgs) {
  if (!args.text.trim()) return { kind: "denied" as const, code: "MESSAGE_EMPTY" as const };

  if (!parentNoteFits(args.text))
    return { kind: "denied" as const, code: "MESSAGE_TOO_LARGE" as const };

  const input = {
    assignmentId: args.assignmentId,
    turnToken: args.turnToken,
    op: "message_parent" as const,
  };

  const live = await interaction(ctx, input, true);

  if (live.kind === "denied") return live;

  const receipt = await findReceipt(ctx, `parent-note:${args.assignmentId}`, args.key);

  if (receipt) {
    if (receipt.fingerprint !== args.fingerprint)
      return { kind: "denied" as const, code: "KEY_CONFLICT" as const };

    return {
      kind: "replay" as const,
      messageId: (receipt.result as { messageId: string }).messageId,
    };
  }

  return interactionTarget(ctx, input);
}

/** Trusted native-save target or a replay/denial; fresh limits precede every save. */
export const parentNoteContext = query({
  args: noteArgs,
  returns: v.union(interactionResult, replay),
  handler: context,
});

/** Record the exact native id and receipt with queue publication in the host transaction. */
export const messageParent = mutation({
  args: { ...noteArgs, messageId: v.string() },
  returns: accepted,
  handler: async (ctx, args) => {
    const target = await context(ctx, args);

    if (target.kind === "denied") throw new Error(target.code);

    if (target.kind === "replay")
      return { status: "accepted" as const, messageId: target.messageId };

    const value = await interaction(ctx, { ...args, op: "message_parent" });

    if (value.kind === "denied") throw new Error(value.code);

    const { run, budget, parent } = value;
    const result = { status: "accepted" as const, messageId: args.messageId };

    await ctx.db.patch("subagentRuns", run._id, {
      parentNotesSent: run.parentNotesSent + 1,
      lastParentNoteAt: Date.now(),
    });

    await ctx.db.patch("runs", budget._id, { hops: budget.hops + 1 });
    await armPurge(ctx);

    await ctx.db.insert(
      "receipts",
      newDoneReceipt({
        scope: `parent-note:${args.assignmentId}`,
        key: args.key,
        fingerprint: args.fingerprint,
        result,
      }),
    );

    await post(ctx, parent, budget._id, args.messageId, "note", false, run.agent);

    return result;
  },
});
