/**
 * The exact-message reference ring on `assignments.contextMessages`.
 *
 * Watched assignments (those a side review reads) record the identity, order
 * and size of every successful user/assistant message in the same transaction
 * that saves it natively, so a review can later read exactly those documents
 * without listing the transcript. Writers: turns.slices.write (model saves),
 * turns.send.accept / subagents.launch.attach (prompts), hooks.reviews.capture (host coordinator
 * saves) and hooks/notes.ts (notes). Readers: `reviewWindow`
 * (`hooks.reviews.reviewContext`), with `markReviewed` (`hooks.reviews.reviewed`) recording
 * each side reviewer's consumed boundary.
 */
import { getConvexSize, v, type Infer } from "convex/values";
import type { MessageDoc } from "@convex-dev/agent";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";

/** One recorded native message: id, native order/stepOrder and stored size. */
export const messageRef = v.object({
  id: v.string(),
  order: v.number(),
  stepOrder: v.number(),
  bytes: v.number(),
});

/** The newest ref always carries the highest sequence: every push takes
 * ++sequence, the list is sorted by it, and the bounded ring keeps the tail.
 * Hence no separate counter is stored; 0 means nothing was ever recorded. */
export function latestSequence(refs: { sequence: number }[] | undefined) {
  return refs && refs.length ? refs[refs.length - 1].sequence : 0;
}

/** Append refs to the ring (re-saving an id moves it to the tail) and keep
 * only the newest `LIMITS.contextMessages`. A no-op for unwatched rows. */
export async function recordRefs(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  messages: Infer<typeof messageRef>[],
) {
  // Unwatched agents need no delta journal. In particular, do not add a
  // metadata write to every native save in delegation-only applications.
  if (!row.contextMessages || !messages.length) return;

  const refs = [...row.contextMessages];
  let sequence = latestSequence(row.contextMessages);

  for (const message of messages) {
    const existing = refs.findIndex((ref) => ref.id === message.id);

    if (existing >= 0) refs.splice(existing, 1);

    refs.push({ ...message, sequence: ++sequence });
  }

  refs.sort((a, b) => a.sequence - b.sequence);

  await ctx.db.patch("assignments", row._id, {
    contextMessages: refs.slice(-LIMITS.contextMessages),
  });
}

/** Record exact native identities in the creating transaction. The ring contains
 * no copied request/tool content. Native addMessages already returns these docs
 * (Agent 0.7.7 src/client/messages.ts:132-155), so this costs no transcript read.
 * <=24 references *160 bytes <4 KiB per assignment. Side snapshot admission sums
 * recorded document sizes before exact-id reads: <=2 MiB, output <=48 KiB.
 */
export async function recordMessages(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  messages: MessageDoc[],
) {
  await recordRefs(
    ctx,
    row,
    messages
      .filter(
        (message) =>
          message.status === "success" &&
          (row.textConfig?.summary || ["user", "assistant"].includes(message.message?.role ?? "")),
      )
      .map((message) => ({
        id: message._id,
        order: message.order,
        stepOrder: message.stepOrder,
        bytes: getConvexSize(message),
      })),
  );
}

/** The message refs a side reviewer should read now, or null when the turn
 * is stale or its cadence (every `turns` completed turns or `minutes`) is not
 * yet due. Takes the newest refs since the reviewer's last boundary within
 * `LIMITS.contextReadBytes`, in native order, plus the new boundary. */
export async function reviewWindow(
  ctx: QueryCtx,
  args: {
    assignmentId: Id<"assignments">;
    executionId: string;
    agent: string;
    turns?: number;
    minutes?: number;
  },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (!row || row.cancelled || row.turnToken !== args.executionId || row.turnStatus !== "running")
    return null;

  const last = row.reviewed?.find((review) => review.agent === args.agent);

  const due =
    args.turns !== undefined
      ? row.completedTurns - (last?.turn ?? 0) >= args.turns
      : Date.now() - (last?.at ?? row._creationTime) >= args.minutes! * LIMITS.minuteMs;

  if (!due) return null;

  let bytes = 0;

  const refs = (row.contextMessages ?? [])
    .filter((ref) => !last || ref.sequence > last.boundary)
    .reverse()
    .filter((ref) => {
      if (bytes + ref.bytes > LIMITS.contextReadBytes) return false;

      bytes += ref.bytes;

      return true;
    })
    .reverse();

  // Native orders are NOT save order: later user prompts may already be
  // queued when an earlier assistant response commits. A monotonic capture
  // boundary retains that response for the next review rather than losing it.
  refs.sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);

  return { refs, boundary: latestSequence(row.contextMessages) };
}

/** Record that a side reviewer consumed the ring up to `boundary` at this
 * turn, replacing its previous entry (at most `LIMITS.sideAgents` reviewers). */
export async function markReviewed(
  ctx: MutationCtx,
  args: { assignmentId: Id<"assignments">; executionId: string; agent: string; boundary: number },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (!row || row.cancelled || row.turnToken !== args.executionId) throw new Error("STALE_TURN");

  const reviewed = (row.reviewed ?? []).filter((review) => review.agent !== args.agent);

  if (reviewed.length >= LIMITS.sideAgents) throw new Error("SIDE_AGENT_LIMIT");

  reviewed.push({
    agent: args.agent,
    turn: row.completedTurns,
    at: Date.now(),
    boundary: args.boundary,
  });

  await ctx.db.patch("assignments", row._id, { reviewed });

  return null;
}
