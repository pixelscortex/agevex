import { getConvexSize, v, type Infer } from "convex/values";
import type { MessageDoc } from "@convex-dev/agent";
import type { FunctionHandle } from "convex/server";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { LIMITS } from "./limits.js";
import { validModelOverrides } from "./models.js";

export const messageRef = v.object({
  id: v.string(),
  order: v.number(),
  stepOrder: v.number(),
  bytes: v.number(),
});

export async function recordRefs(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  messages: Infer<typeof messageRef>[],
) {
  // Unwatched agents need no delta journal. In particular, do not add a
  // metadata write to every native save in delegation-only applications.
  if (!row.contextMessages || !messages.length) return;
  const refs = [...row.contextMessages];
  let sequence = row.contextSequence ?? 0;
  for (const message of messages) {
    const existing = refs.findIndex((ref) => ref.id === message.id);
    if (existing >= 0) refs.splice(existing, 1);
    refs.push({ ...message, sequence: ++sequence });
  }
  refs.sort((a, b) => a.sequence - b.sequence);
  await ctx.db.patch("assignments", row._id, {
    contextMessages: refs.slice(-LIMITS.contextMessages),
    contextSequence: sequence,
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

export const takeNotes = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    getMessages: v.string(),
    addMessages: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (
      !row ||
      row.cancelled ||
      row.turnToken !== args.executionId ||
      row.turnStatus !== "running" ||
      row.pendingGeneration
    )
      return false;
    const cap = (row.limits?.notesPerTurn ?? LIMITS.notesPerTurn) - (row.notesTaken ?? 0);
    if (cap <= 0) return false;
    // One exact note per transaction: <=50 KiB body + six native merge heads
    // <=6 MiB + bounded stream-abort metadata + assignment <8 MiB <16 MiB.
    // The action drains <=24 notes using separate transactions, so native reads
    // never multiply by notesPerTurn. No workflow step or transcript scan.
    const note = await ctx.db
      .query("inbox")
      .withIndex("by_assignment_ready", (q) => q.eq("assignmentId", row._id).eq("passive", true))
      .first();
    if (!note) return false;
    if (note.deferredNoteDelete) {
      const [message] = (await ctx.runQuery(args.getMessages as FunctionHandle<"query">, {
        messageIds: [note.messageId],
      })) as (MessageDoc | null)[];
      if (!message || message.threadId !== row.threadId || message.message?.role !== "user")
        throw new Error("NOTE_MISSING");
      // A pending user note stores the original payload only in Agent. Once
      // the step finishes, atomically replace that provisional document with
      // an ordinary user message AFTER the complete tool-call/result pair.
      // Native deleteByIds operates on our recorded id; streams have finished
      // before this boundary. No read-time suppression or message injection.
      await ctx.runMutation(note.deferredNoteDelete as FunctionHandle<"mutation">, {
        messageIds: [note.messageId],
      });
      const saved = (await ctx.runMutation(args.addMessages as FunctionHandle<"mutation">, {
        threadId: row.threadId,
        order: message.order,
        agentName: message.agentName,
        messages: [{ message: message.message }],
      })) as { messages: MessageDoc[] };
      await recordMessages(ctx, row, saved.messages);
    }
    await ctx.db.delete("inbox", note._id);
    await ctx.db.patch("assignments", row._id, {
      notesTaken: (row.notesTaken ?? 0) + 1,
      notesPending: row.notesPending - 1,
    });
    return true;
  },
});

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
  const anchor = row.promptMessageId ?? row.latestRequestMessageId;
  const [message] = (await ctx.runQuery(getMessages as FunctionHandle<"query">, {
    messageIds: [anchor],
  })) as (MessageDoc | null)[];
  if (!message || message.threadId !== row.threadId) throw new Error("CONTROL_ANCHOR_MISSING");
  return message.order;
}

export const hookState = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    model: v.optional(v.string()),
    error: v.optional(v.string()),
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
    await ctx.db.patch("assignments", row._id, {
      ...(args.error !== undefined
        ? { hookError: args.error.slice(0, LIMITS.hookErrorLength) }
        : {}),
      ...(args.complete ? { completedTurns: (row.completedTurns ?? 0) + 1 } : {}),
    });
    return (row.completedTurns ?? 0) + (args.complete ? 1 : 0);
  },
});

export const continueAdmission = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    prompt: v.string(),
    addMessages: v.string(),
    getMessages: v.string(),
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
      (run.continues ?? 0) >= (row.limits?.continuesPerRun ?? LIMITS.continuesPerRun)
    )
      return null;
    // Admission, native prompt save, and exact-id capture are one transaction.
    // A lost action response cannot leave an untracked control prompt behind.
    const saved = (await ctx.runMutation(args.addMessages as FunctionHandle<"mutation">, {
      threadId: row.threadId,
      order: await controlOrder(ctx, row, args.getMessages),
      messages: [{ message: { role: "user", content: args.prompt } }],
    })) as { messages: MessageDoc[] };
    const messageId = saved.messages[0]._id;
    await recordMessages(ctx, row, saved.messages);
    await ctx.db.patch("runs", run._id, { continues: (run.continues ?? 0) + 1 });
    await ctx.db.patch("assignments", row._id, {
      hookContinue: true,
      logicalPromptMessageId: messageId,
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
        ? (row.completedTurns ?? 0) - (last?.turn ?? 0) >= args.turns
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
    return { refs, boundary: row.contextSequence ?? 0 };
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
      turn: row.completedTurns ?? 0,
      at: Date.now(),
      boundary: args.boundary,
    });
    await ctx.db.patch("assignments", row._id, { reviewed });
    return null;
  },
});

/** Called through queue.write's execution/epoch fence. Native addMessages and
 * passive admission are nested mutations in the SAME Convex transaction. */
export const addNote = mutation({
  args: {
    assignmentId: v.id("assignments"),
    text: v.string(),
    from: v.string(),
    addMessages: v.string(),
    getMessages: v.string(),
    deleteMessages: v.string(),
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
    if (row.notesPending >= (row.limits?.notesPending ?? LIMITS.notesPending)) return false;
    const escape = (text: string) =>
      text.replace(
        /[&<>"']/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
      );
    const saved = (await ctx.runMutation(args.addMessages as FunctionHandle<"mutation">, {
      threadId: row.threadId,
      order: await controlOrder(ctx, row, args.getMessages),
      agentName: args.from,
      messages: [
        {
          // Agent reserves the assistant slot before model I/O and fills it
          // later (vercel/client/start.ts:213-232,383-395). A successful note
          // here could split that assistant tool call from its result. Keep
          // only in-flight notes pending until the completed-step boundary.
          ...(row.pendingGeneration ? { status: "pending" } : {}),
          message: {
            role: "user",
            content: `<note from="${escape(args.from)}">${escape(args.text)}</note>`,
          },
        },
      ],
    })) as { messages: MessageDoc[] };
    const message = saved.messages[0];
    await ctx.db.insert("inbox", {
      assignmentId: row._id,
      messageId: message._id,
      sequence: row.nextSequence,
      runId: row.runId!,
      kind: "note",
      passive: true,
      ...(row.pendingGeneration ? { deferredNoteDelete: args.deleteMessages } : {}),
    });
    await ctx.db.patch("assignments", row._id, {
      notesPending: row.notesPending + 1,
      nextSequence: row.nextSequence + 1,
    });
    await recordMessages(ctx, row, saved.messages);
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
      pending: ((run.routingAgents ?? 0n) & (1n << BigInt(args.agentIndex))) !== 0n,
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
        (run.routingAgents ?? 0n) & ~(1n << BigInt(row.routingAgentIndex)),
      ),
    });
  await ctx.db.patch("assignments", row._id, { routingAgentIndex: undefined });
}
