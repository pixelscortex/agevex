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
  args: { assignmentId: v.id("assignments"), executionId: v.string(), getMessages: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.cancelled || row.turnToken !== args.executionId || row.turnStatus !== "running")
      return null;
    const cap = (row.limits?.notesPerTurn ?? LIMITS.notesPerTurn) - (row.notesTaken ?? 0);
    if (cap <= 0) return row.promptMessageId ?? null;
    const notes = await ctx.db
      .query("inbox")
      .withIndex("by_assignment_ready", (q) => q.eq("assignmentId", row._id).eq("passive", true))
      .take(cap);
    if (!notes.length) return row.promptMessageId ?? null;
    // <=24 escaped notes *~50 KiB +one <=1 MiB anchor <2.25 MiB.
    // Exact native orders prevent an older note from hiding a newer user prompt.
    const docs = (await ctx.runQuery(args.getMessages as FunctionHandle<"query">, {
      messageIds: [row.promptMessageId!, ...notes.map((n) => n.messageId)],
    })) as MessageDoc[];
    const ordered = docs
      .filter(Boolean)
      .sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);
    const newest = ordered[ordered.length - 1];
    for (const note of notes) await ctx.db.delete("inbox", note._id);
    await ctx.db.patch("assignments", row._id, {
      notesTaken: (row.notesTaken ?? 0) + notes.length,
      queuedMessages: row.queuedMessages - notes.length,
      promptMessageId: newest?._id ?? row.promptMessageId,
    });
    return newest?._id ?? row.promptMessageId ?? null;
  },
});

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
  args: { assignmentId: v.id("assignments"), executionId: v.string() },
  handler: async (ctx, args) => {
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
      return false;
    await ctx.db.patch("runs", run._id, { continues: (run.continues ?? 0) + 1 });
    await ctx.db.patch("assignments", row._id, { hookContinue: true });
    return true;
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
    const cap = row.limits?.notesPerTurn ?? LIMITS.notesPerTurn;
    const notes = await ctx.db
      .query("inbox")
      .withIndex("by_assignment_ready", (q) => q.eq("assignmentId", row._id).eq("passive", true))
      .take(cap);
    if (
      notes.length + (row.turnStatus === "running" ? (row.notesTaken ?? 0) : 0) >= cap ||
      row.queuedMessages >= (row.limits ?? LIMITS).queueLength
    )
      return false;
    const escape = (text: string) =>
      text.replace(
        /[&<>"']/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
      );
    const saved = (await ctx.runMutation(args.addMessages as FunctionHandle<"mutation">, {
      threadId: row.threadId,
      agentName: args.from,
      messages: [
        {
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
    });
    await ctx.db.patch("assignments", row._id, {
      queuedMessages: row.queuedMessages + 1,
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
    const run = await ctx.db.get("runs", row.runId);
    if (run)
      await ctx.db.patch("runs", run._id, {
        routingAgents: BigInt.asIntN(
          LIMITS.agents,
          (run.routingAgents ?? 0n) & ~(1n << BigInt(args.agentIndex)),
        ),
      });
    return null;
  },
});
