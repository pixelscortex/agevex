/**
 * Notes and staged hook continuations, from admission to native history.
 *
 * Notes are short `<note from="...">` user messages posted by hooks or the
 * host. `addNote` (`queueNote`) keeps one as a passive `inbox` row (body in
 * `text`) until a safe turn claim saves it (`claimNotes`, called by
 * turns/claim.ts), placed after the prior response and before the claimed
 * work. `beforeTurnNote` (`saveBeforeTurnNote`) saves one immediately when
 * no approval results are outstanding. `cancelNotes` (`dropCancelledNotes`)
 * deletes a cancelled epoch's unsaved bodies. Touches `inbox` and
 * `assignments`.
 */
import { ConvexError, v, type Infer } from "convex/values";
import type { MessageDoc } from "@convex-dev/agent";
import type { FunctionHandle } from "convex/server";
import { api } from "../_generated/api.js";
import { type MutationCtx, mutation, internalMutation } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";
import { awaitingApprovalResults } from "../turns/pause.js";
import { recordMessages } from "./refs.js";

/** The native Agent handles claim needs to place notes: read the anchor, save
 * empty assistant slots, then turn each slot into the note's user message. */
export const noteHandles = v.object({
  getMessages: v.string(),
  addMessages: v.string(),
  updateMessage: v.string(),
});

/** Called only by claim, after choosing the claimed work and before publishing
 * its running state. Posted notes never write native history anywhere else.
 * Agent 0.7.7 component/messages.ts:302-305,390-406 supports integer order,
 * but moves subsequent USER messages to a fresh order. Allocate successful
 * empty assistant slots in one batch, then finalize their user roles with
 * updateMessage (:553-597), preserving both arrival order and native positions.
 * <=24 raw rows *17 KiB read twice + six native merge heads <=6 MiB + one
 * anchor <=1 MiB +24 escaped notes *50 KiB +metadata <128 KiB: <10 MiB read,
 * <3 MiB written. A hook continuation adds <=64 KiB read/write. The bounded
 * ready-group claim uses metadata only; native heads are read just once.
 */
export async function claimNotes(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  handles: Infer<typeof noteHandles>,
  order: number,
  continuation?: Doc<"inbox">,
) {
  const notes = await ctx.db
    .query("inbox")
    .withIndex("by_assignment_ready", (q) =>
      q.eq("assignmentId", row._id).eq("passive", true).eq("noteEpoch", row.cancellationEpoch),
    )
    .take(row.limits.notesPending);

  if (!notes.length && !continuation) return;

  const controls = [
    ...notes.map((note) => ({ row: note, message: noteMessage(note.text!, note.from!) })),
    ...(continuation
      ? [
          {
            row: continuation,
            message: { role: "user" as const, content: continuation.text! },
          },
        ]
      : []),
  ];

  const saved = (await ctx.runMutation(handles.addMessages as FunctionHandle<"mutation">, {
    threadId: row.threadId,
    order,
    failPendingSteps: false,
    messages: controls.map(() => ({
      status: "success",
      message: { role: "assistant", content: [] },
    })),
  })) as { messages: MessageDoc[] };

  const finalized: MessageDoc[] = [];

  for (let index = 0; index < controls.length; index++) {
    finalized.push(
      await finalizeControl(ctx, row, handles, controls[index], saved.messages[index]._id),
    );
  }

  await recordMessages(ctx, row, finalized);
  await ctx.db.patch("assignments", row._id, { notesPending: 0 });
}

/** Turn one reserved assistant slot into the control's user message, retire
 * its body from the inbox row (keeping the id as origin metadata), and make a
 * hook continuation the turn's prompt. */
async function finalizeControl(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  handles: Infer<typeof noteHandles>,
  control: { row: Doc<"inbox">; message: { role: "user"; content: string } },
  slotId: string,
) {
  const message = (await ctx.runMutation(handles.updateMessage as FunctionHandle<"mutation">, {
    messageId: slotId,
    patch: { message: control.message },
  })) as MessageDoc;

  await ctx.db.patch("inbox", control.row._id, {
    messageId: message._id,
    text: undefined,
    passive: false,
  });

  if (control.row.kind === "continue") {
    row.promptMessageId = message._id;
    await ctx.db.patch("assignments", row._id, { promptMessageId: message._id });
  }

  return message;
}

/** Agent 0.7.7 client/messages.ts:132-138 forwards promptMessageId/order.
 * component/messages.ts:306-318 selects the anchor group, but :392-406 moves
 * USER messages to a fresh order even with promptMessageId. Its supported
 * numeric order option (:302-305,391-392) instead appends the first user message
 * at the next stepOrder. Both options together are rejected (:258-262).
 * Read one recorded anchor id, then save one user control with that order in
 * this same transaction. No transcript scan or read-time context adapter.
 * Exact anchor <=1 MiB + six native merge heads <=6 MiB + one save/result
 * <=130 KiB + assignment/ref metadata <128 KiB: <8 MiB <16 MiB per control.
 */
export async function controlOrder(ctx: MutationCtx, row: Doc<"assignments">, getMessages: string) {
  const anchor = row.promptMessageId;

  const [message] = (await ctx.runQuery(getMessages as FunctionHandle<"query">, {
    messageIds: [anchor],
  })) as (MessageDoc | null)[];

  if (!message || message.threadId !== row.threadId) throw new Error("CONTROL_ANCHOR_MISSING");

  return message.order;
}

/** The native user message for a note, with `from` and the body XML-escaped
 * so a note can never forge or close the `<note>` envelope. */
function noteMessage(text: string, from: string) {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
    );

  return { role: "user" as const, content: `<note from="${escape(from)}">${escape(text)}</note>` };
}

/** Save one note natively at `order` (from controlOrder) and return the doc. */
export async function saveNote(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  addMessages: string,
  order: number,
  text: string,
  from: string,
) {
  const saved = (await ctx.runMutation(addMessages as FunctionHandle<"mutation">, {
    threadId: row.threadId,
    order,
    agentName: from,
    messages: [{ message: noteMessage(text, from) }],
  })) as { messages: MessageDoc[] };

  return saved.messages[0];
}

/** A note body and sender within their admission bounds: <=4,000 UTF-16
 * units of text (<=16 KiB) and a non-empty sender of request-key length. */
function validNote(text: string, from: string) {
  return (
    !!text.trim() &&
    text.length <= LIMITS.noteLength &&
    !!from &&
    from.length <= LIMITS.requestKeyLength
  );
}

/** turns.slices.write fences hook notes by execution/epoch; external notes serialize
 * against cancellation here. Every post retains only its bounded raw payload.
 * Refuses past the assignment's `notesPending` cap. */
export async function queueNote(
  ctx: MutationCtx,
  args: { assignmentId: Id<"assignments">; text: string; from: string },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (!row || row.cancelled || !validNote(args.text, args.from)) throw new Error("INVALID_NOTE");

  if (row.notesPending >= row.limits.notesPending)
    throw new ConvexError({ code: "NOTES_PENDING_LIMIT" });

  // <=4,000 UTF-16 units => <=16 KiB plus <1 KiB metadata. A note
  // never wakes a turn, even when idle or paused with unresolved tool calls.
  await ctx.db.insert("inbox", {
    assignmentId: row._id,
    messageId: "",
    sequence: row.nextSequence,
    runId: row.runId!,
    kind: "note",
    passive: true,
    from: args.from,
    noteEpoch: row.cancellationEpoch,
    text: args.text,
  });

  await ctx.db.patch("assignments", row._id, {
    notesPending: row.notesPending + 1,
    nextSequence: row.nextSequence + 1,
  });

  return true;
}

/** Before-turn notes can enter history immediately only when prior approvals
 * have committed their results. Otherwise share the pending-note admission cap
 * and defer delivery to a safe claim. turns.slices.write supplies the epoch fence.
 */
export async function saveBeforeTurnNote(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<"assignments">;
    text: string;
    from: string;
    addMessages: string;
    getMessages: string;
  },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (
    !row ||
    row.cancelled ||
    row.turnStatus !== "running" ||
    row.pendingGeneration ||
    !validNote(args.text, args.from)
  )
    throw new Error("INVALID_NOTE");

  if (awaitingApprovalResults(row)) {
    await ctx.runMutation(api.hooks.notes.addNote, {
      assignmentId: row._id,
      text: args.text,
      from: args.from,
    });

    return;
  }

  const order = await controlOrder(ctx, row, args.getMessages);
  const message = await saveNote(ctx, row, args.addMessages, order, args.text, args.from);

  await ctx.db.insert("inbox", {
    assignmentId: row._id,
    messageId: message._id,
    sequence: row.nextSequence,
    runId: row.runId!,
    kind: "note",
    passive: false,
    from: args.from,
  });

  await recordMessages(ctx, row, [message]);
  await ctx.db.patch("assignments", row._id, { nextSequence: row.nextSequence + 1 });
}

/** Cancellation never loads the raw note bodies across all sixteen assignments.
 * One finite job per assignment reads/deletes <=24*17 KiB twice +32 KiB
 * assignment metadata =848 KiB (<864 KiB).
 * Pending notes have never entered Agent; delivered origin rows are excluded.
 * The epoch index fences a fresh send even when it precedes this job. Each
 * cancelled epoch has <=24 notes, so no chain or history prefix is needed.
 */
export async function dropCancelledNotes(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  epoch: number,
) {
  const row = await ctx.db.get("assignments", assignmentId);

  if (!row) return;

  const notes = await ctx.db
    .query("inbox")
    .withIndex("by_assignment_ready", (q) =>
      q.eq("assignmentId", assignmentId).eq("passive", true).eq("noteEpoch", epoch),
    )
    .take(row.limits.notesPending);

  for (const note of notes) {
    await ctx.db.delete("inbox", note._id);
  }
}

/** Queue a note for the next safe claim; see `queueNote`. */
export const addNote = mutation({
  args: {
    assignmentId: v.id("assignments"),
    text: v.string(),
    from: v.string(),
  },
  returns: v.boolean(),
  handler: (ctx, args): Promise<boolean> => queueNote(ctx, args),
});

/** Save a beforeTurn note now, or queue it behind outstanding approval
 * results; see `saveBeforeTurnNote`. */
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

/** Delete a cancelled epoch's unsaved note bodies; one finite job per
 * assignment, scheduled by turns.cancel.cancel. */
export const cancelNotes = internalMutation({
  args: { assignmentId: v.id("assignments"), epoch: v.number() },
  handler: (ctx, { assignmentId, epoch }) => dropCancelledNotes(ctx, assignmentId, epoch),
});
