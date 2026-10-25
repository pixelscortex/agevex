import { ConvexError, getConvexSize, v, type Infer } from "convex/values";
import type { MessageDoc } from "@convex-dev/agent";
import type { FunctionHandle } from "convex/server";
import { mutation, query, internalMutation, type MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { LIMITS } from "./limits.js";
import { validModelOverrides } from "./models.js";
import { api } from "./_generated/api.js";

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
          ["user", "assistant"].includes(message.message?.role ?? ""),
      )
      .map((message) => ({
        id: message._id,
        order: message.order,
        stepOrder: message.stepOrder,
        bytes: getConvexSize(message),
      })),
  );
}

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
    const control = controls[index];
    const message = (await ctx.runMutation(handles.updateMessage as FunctionHandle<"mutation">, {
      messageId: saved.messages[index]._id,
      patch: { message: control.message },
    })) as MessageDoc;
    finalized.push(message);
    await ctx.db.patch("inbox", control.row._id, {
      messageId: message._id,
      text: undefined,
      passive: false,
    });
    if (control.row.kind === "continue") {
      row.promptMessageId = message._id;
      row.logicalPromptMessageId = message._id;
      await ctx.db.patch("assignments", row._id, {
        promptMessageId: message._id,
        logicalPromptMessageId: message._id,
      });
    }
  }
  await recordMessages(ctx, row, finalized);
  await ctx.db.patch("assignments", row._id, { notesPending: 0 });
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
async function controlOrder(ctx: MutationCtx, row: Doc<"assignments">, getMessages: string) {
  const anchor = row.promptMessageId;
  const [message] = (await ctx.runQuery(getMessages as FunctionHandle<"query">, {
    messageIds: [anchor],
  })) as (MessageDoc | null)[];
  if (!message || message.threadId !== row.threadId) throw new Error("CONTROL_ANCHOR_MISSING");
  return message.order;
}

function noteMessage(text: string, from: string) {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
    );
  return { role: "user" as const, content: `<note from="${escape(from)}">${escape(text)}</note>` };
}

async function saveNote(
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

/** Cancellation never loads the raw note bodies across all sixteen assignments.
 * One finite job per assignment reads/deletes <=24*17 KiB twice +32 KiB
 * assignment metadata =848 KiB (<864 KiB).
 * Pending notes have never entered Agent; delivered origin rows are excluded.
 * The epoch index fences a fresh send even when it precedes this job. Each
 * cancelled epoch has <=24 notes, so no chain or history prefix is needed.
 */
export const cancelNotes = internalMutation({
  args: { assignmentId: v.id("assignments"), epoch: v.number() },
  handler: async (ctx, { assignmentId, epoch }) => {
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
  },
});

/** Page-local indexed lookups: <=100 controls *1 KiB +100 results *4 KiB
 * +32 KiB ownership =532 KiB, <=201 documents and <=201 index queries.
 * Control rows with a native id never retain bodies; no history prefix is read.
 */
export const origins = query({
  args: { assignmentId: v.id("assignments"), subject: v.string(), messageIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.messageIds.length > LIMITS.messagePage) throw new Error("INVALID_PAGE");
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.subject !== args.subject) throw new Error("FORBIDDEN");
    const origins: Record<
      string,
      { origin: "note" | "continue" | "result"; from?: string; runId?: string }
    > = {};
    for (const id of args.messageIds) {
      const control = await ctx.db
        .query("inbox")
        .withIndex("by_message", (q) => q.eq("messageId", id))
        .unique();
      if (
        control?.assignmentId === row._id &&
        (control.kind === "note" || control.kind === "continue")
      ) {
        origins[id] = {
          origin: control.kind,
          ...(control.kind === "note" ? { from: control.from! } : {}),
        };
        continue;
      }
      const result = await ctx.db
        .query("subagentRuns")
        .withIndex("by_result_message", (q) => q.eq("resultMessageId", id))
        .unique();
      if (result?.actorAssignmentId === row._id)
        origins[id] = { origin: "result", runId: result.runId };
    }
    return origins;
  },
});

export const hookState = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    model: v.optional(v.string()),
    complete: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.cancelled || row.turnToken !== args.executionId || row.turnStatus !== "running")
      throw new Error("STALE_TURN");
    if (args.model && row.runId) {
      const run = await ctx.db.get("runs", row.runId);
      const models = { ...run?.models, [row.agent]: args.model };
      if (!run || !validModelOverrides(models)) throw new Error("INVALID_MODELS");
      await ctx.db.patch("runs", run._id, { models });
    }
    if (args.complete)
      await ctx.db.patch("assignments", row._id, { completedTurns: row.completedTurns + 1 });
    return row.completedTurns + (args.complete ? 1 : 0);
  },
});

export const continueAdmission = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.prompt.trim() || args.prompt.length > LIMITS.messageLength)
      throw new Error("INVALID_CONTINUE");
    const row = await ctx.db.get("assignments", args.assignmentId);
    const run = row?.runId ? await ctx.db.get("runs", row.runId) : null;
    if (
      !row ||
      row.cancelled ||
      row.turnToken !== args.executionId ||
      row.turnStatus !== "running" ||
      !run ||
      run.cancelled ||
      run.continues >= row.limits.continuesPerRun
    )
      return null;
    // Stage the hook prompt until its claim so pending notes can be placed
    // after the completed response and BEFORE this continuation in one batch.
    // <=16,000 UTF-16 units (64 KiB) plus metadata, well below 1 MiB.
    const messageId = await ctx.db.insert("inbox", {
      assignmentId: row._id,
      messageId: "",
      text: args.prompt,
      sequence: row.nextSequence,
      runId: run._id,
      kind: "continue",
      passive: false,
    });
    await ctx.db.patch("runs", run._id, { continues: run.continues + 1 });
    await ctx.db.patch("assignments", row._id, {
      hookContinue: true,
      nextSequence: row.nextSequence + 1,
      inboxId: messageId,
    });
    return messageId;
  },
});

export const reviewContext = query({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    agent: v.string(),
    turns: v.optional(v.number()),
    minutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
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
  },
});

export const reviewed = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    agent: v.string(),
    boundary: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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
  },
});

/** queue.write fences hook notes by execution/epoch; external notes serialize
 * against cancellation here. Every post retains only its bounded raw payload. */
export const addNote = mutation({
  args: {
    assignmentId: v.id("assignments"),
    text: v.string(),
    from: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (
      !row ||
      row.cancelled ||
      !args.text.trim() ||
      args.text.length > LIMITS.noteLength ||
      !args.from ||
      args.from.length > LIMITS.requestKeyLength
    )
      throw new Error("INVALID_NOTE");
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
  },
});

/** Host coordinator saves (results, questions and follow-ups) do not pass
 * through the action's native-save fence. Capture their identities inside that
 * same host mutation too, so delta never omits a non-model message. */
export const capture = mutation({
  args: { threadId: v.string(), savedMessage: messageRef },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (row) await recordRefs(ctx, row, [args.savedMessage]);
    return null;
  },
});

export const routing = query({
  args: { assignmentId: v.id("assignments"), agentIndex: v.number() },
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.agentIndex) ||
      args.agentIndex < 0 ||
      args.agentIndex >= LIMITS.agents
    )
      throw new Error("INVALID_AGENT_INDEX");
    const row = await ctx.db.get("assignments", args.assignmentId);
    const run = row?.runId ? await ctx.db.get("runs", row.runId) : null;
    if (!row || !run || row.cancelled || run.cancelled) return null;
    return {
      pending: (run.routingAgents & (1n << BigInt(args.agentIndex))) !== 0n,
      modelId: run.models?.[row.agent],
    };
  },
});

export const completeRouting = mutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string(), agentIndex: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.agentIndex) ||
      args.agentIndex < 0 ||
      args.agentIndex >= LIMITS.agents
    )
      throw new Error("INVALID_AGENT_INDEX");
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.cancelled || row.turnToken !== args.executionId || !row.runId) return null;
    if (row.routingAgentIndex === args.agentIndex) await settleRouting(ctx, row);
    return null;
  },
});

/** The first claimed slice owns one routing attempt, never a retry. A terminal
 * owner keeps startedAgents set and releases routingAgents; waiting siblings
 * use the last committed run model, or their default if no decision committed.
 * Ownership lives on that assignment so watchdog/cancel can settle it without
 * scanning siblings or trusting a failed action to run cleanup. <=3 metadata
 * reads (get run, read run for patch, read assignment for patch) and <=2 writes:
 * (1+1+32)=34 KiB read per owner, included in limits.ts's cancel budget. No
 * native content is accessed.
 */
export async function settleRouting(ctx: MutationCtx, row: Doc<"assignments">) {
  if (row.routingAgentIndex === undefined || !row.runId) return;
  const run = await ctx.db.get("runs", row.runId);
  if (run)
    await ctx.db.patch("runs", run._id, {
      routingAgents: BigInt.asIntN(
        LIMITS.agents,
        run.routingAgents & ~(1n << BigInt(row.routingAgentIndex)),
      ),
    });
  await ctx.db.patch("assignments", row._id, { routingAgentIndex: undefined });
}

/** Decided approvals still need native results from continuation generation. */
export function awaitingApprovalResults(row: Doc<"assignments">) {
  return !!row.approvals?.requests.some((request) => request.resolved);
}

/** Before-turn notes can enter history immediately only when prior approvals
 * have committed their results. Otherwise share the pending-note admission cap
 * and defer delivery to a safe claim. queue.write supplies the epoch fence.
 */
export const beforeTurnNote = mutation({
  args: {
    assignmentId: v.id("assignments"),
    text: v.string(),
    from: v.string(),
    addMessages: v.string(),
    getMessages: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (
      !row ||
      row.cancelled ||
      row.turnStatus !== "running" ||
      row.pendingGeneration ||
      !args.text.trim() ||
      args.text.length > LIMITS.noteLength ||
      !args.from ||
      args.from.length > LIMITS.requestKeyLength
    )
      throw new Error("INVALID_NOTE");
    if (awaitingApprovalResults(row)) {
      await ctx.runMutation(api.hooks.addNote, {
        assignmentId: row._id,
        text: args.text,
        from: args.from,
      });
      return;
    }
    const message = await saveNote(
      ctx,
      row,
      args.addMessages,
      await controlOrder(ctx, row, args.getMessages),
      args.text,
      args.from,
    );
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
  },
});
