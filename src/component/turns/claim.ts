/**
 * `turns.slices.claim`: the host action's admission to run ONE paid model slice.
 *
 * The first slice of a queued turn consumes its reserved inbox head (and any
 * consecutive results of the same run), flushes posted notes into native
 * history, marks the turn running and arms the slice watchdog. Later slices
 * of the same turn need a fresh slice id while the turn is between slices.
 * The claim also records run start / routing ownership for hooks and, for a
 * child, marks its delegation running. It returns the execution scope the
 * action generates under. Touches `assignments`, `inbox`, `runs` and
 * `subagentRuns`; notes go through hooks/notes.ts.
 */
import type { MessageDoc } from "@convex-dev/agent";
import type { FunctionHandle } from "convex/server";
import { v, type Infer } from "convex/values";
import { api, internal } from "../_generated/api.js";
import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { scope, turnOrigin as vTurnOrigin } from "../schema.js";
import { LIMITS } from "../limits.js";
import { claimNotes, noteHandles } from "../hooks/notes.js";
import { firstReady } from "./inbox.js";
import { appendEvent, runById } from "../subagents/runs.js";
import { assertAgentIndex } from "../hooks/routing.js";
import { disarmRecovery } from "./recovery.js";
import { disarmSlice } from "./boundaries.js";
import { failChild, markRecoveryRequired } from "./finish.js";
import { awaitingApprovalResults } from "./pause.js";
import { isAsking } from "./wake.js";

export const claimArgs = {
  assignmentId: v.id("assignments"),
  turnToken: v.string(),
  sliceId: v.optional(v.string()),
  agentIndex: v.optional(v.number()),
  routeModel: v.optional(v.boolean()),
  notes: v.optional(noteHandles),
};

/** The execution scope of a claimed slice; `subagent` is set for children. */
export const vClaim = v.object({
  ...scope.fields,
  promptMessageId: v.string(),
  runId: v.string(),
  modelId: v.optional(v.string()),
  isTurnStart: v.boolean(),
  isRunStart: v.boolean(),
  turn: v.number(),
  cancellationEpoch: v.number(),
  turnOrigin: vTurnOrigin,
  subagent: v.union(
    v.null(),
    v.object({
      runId: v.string(),
      agent: v.string(),
      rootAgent: v.string(),
      actorAgent: v.string(),
      subject: v.string(),
      rootAssignmentId: v.string(),
      rootThreadId: v.string(),
      childThreadId: v.string(),
      deliveryToken: v.string(),
    }),
  ),
});

type ClaimArgs = {
  assignmentId: Id<"assignments">;
  turnToken: string;
  sliceId?: string;
  agentIndex?: number;
  routeModel?: boolean;
  notes?: Infer<typeof noteHandles>;
};
type Claim = Infer<typeof vClaim>;

/** Claim the next slice of `turnToken`, or return null when this call may not
 * run one (stale token, cancelled, paused for approvals or a question, a
 * replayed slice id, or a corrupt child launch, which is escalated). */
export async function claimSlice(ctx: MutationCtx, args: ClaimArgs): Promise<Claim | null> {
  const { assignmentId, turnToken, sliceId } = args;
  const row = await ctx.db.get("assignments", assignmentId);
  if (!row || row.cancelled || row.approvalBlocked || row.turnToken !== turnToken) return null;
  // An open question is a valid pause, never corrupt execution state. This
  // guard also protects repeated/stale dispatches before any inbox deletion.
  if (await isAsking(ctx, row)) return null;

  const first = row.turnStatus === "queued";
  if (
    !first &&
    // A running turn without a watchdog is between slices: continueTurn
    // disarmed it, and only a fresh slice id may claim the next one.
    !(row.turnStatus === "running" && !row.watchdogId && sliceId && row.lastSlice !== sliceId)
  )
    return null;

  const noteAnchor = first && row.inboxId ? await consumeHead(ctx, row) : row.promptMessageId;
  await flushNotes(ctx, row, first, noteAnchor, args.notes);
  await markRunning(ctx, row, first, args);

  const budget = row.runId ? await ctx.db.get("runs", row.runId) : null;
  const modelId = budget?.models?.[row.agent];
  const isRunStart = await markRunStart(ctx, row, budget, args);
  const claim: Claim = {
    assignmentId,
    threadId: row.threadId,
    subject: row.subject,
    agent: row.agent,
    promptMessageId: row.promptMessageId!,
    runId: row.runId!,
    modelId,
    isTurnStart: first || !!row.hookContinue,
    isRunStart,
    turn: row.completedTurns,
    cancellationEpoch: row.cancellationEpoch,
    turnOrigin: row.turnOrigin!,
    subagent: null,
  };
  return row.childRunId ? claimChild(ctx, row, first, claim) : claim;
}

/** Delete the reserved head and, for result/note/parent work, merge the
 * consecutive ready rows of the same run. Returns the note anchor: the native
 * message after which pending notes are placed. */
async function consumeHead(ctx: MutationCtx, row: Doc<"assignments">) {
  const head = await ctx.db.get("inbox", row.inboxId!);
  if (!head) return row.promptMessageId;

  const noteAnchor = head.join?.earliestId ?? head.messageId;
  await ctx.db.delete("inbox", head._id);
  if (head.kind !== "result" && head.kind !== "note" && head.kind !== "parent") return noteAnchor;

  return mergeConsecutive(ctx, row, head, noteAnchor);
}

/** Consume the consecutive head only. Freeing capacity can publish an
 * already-ready join, so drain that same FIFO before choosing its native
 * anchor. Otherwise an older deferred join could hide a consumed answer
 * on the very next turn. Never cross another run/user turn.
 * <=100 backlog + reserved answer +50 joins + reserved head =152 rows.
 * The by_join "ready" range is scoped to this budget: <=50 members TOTAL
 * across its cohorts. <=100 run metadata reads (400 KiB), <=152
 * inbox deletes/assignment patches and fixed per-iteration probes stay
 * <8 MiB, <2,000 reads/<600 writes even at all host maxima.
 * @convex-dev/agent/src/component/messages.ts:298-322 anchors native
 * context at the prompt's recorded order, rather than our inbox order.
 * Moves `row.promptMessageId` to the newest merged message and returns the
 * earliest one as the note anchor.
 */
async function mergeConsecutive(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  head: Doc<"inbox">,
  noteAnchor: string,
) {
  let newest = head.join?.newestSequence ?? head.sequence;
  let earliest = head.join?.earliestSequence ?? newest;
  const bound = row.limits.queueLength + row.limits.runLaunches + 1;
  for (let count = 0; count < bound; count++) {
    await ctx.runMutation(api.subagents.deliver.releaseGroups, {
      assignmentId: row._id,
      parentRunId: head.runId,
    });
    const item = await firstReady(ctx, row._id);
    if (!item || item.runId !== head.runId || item.kind === "user") break;

    await ctx.db.delete("inbox", item._id);
    const order = item.join?.newestSequence ?? item.sequence;
    const noteOrder = item.join?.earliestSequence ?? order;
    if (noteOrder < earliest) {
      earliest = noteOrder;
      noteAnchor = item.join?.earliestId ?? item.messageId;
    }
    if (order > newest) {
      newest = order;
      row.promptMessageId = item.messageId;
    }
    const current = (await ctx.db.get("assignments", row._id))!;
    await ctx.db.patch("assignments", row._id, {
      queuedMessages: current.queuedMessages - 1,
    });
  }

  await ctx.db.patch("assignments", row._id, { promptMessageId: row.promptMessageId });
  return noteAnchor;
}

/** Flush posted notes only at a turn claim with no decided approvals still
 * awaiting committed results; otherwise retain them for the next safe claim.
 * Agent 0.7.7 src/approvals.ts:67-79 saves only approval responses, even for
 * denials; both outcomes get results during continuation generation. Native
 * result saves retire these recorded approvals, while answer removes its
 * deferred call atomically with the result. Never scan native history or
 * drain notes at ordinary tool-step slices.
 */
async function flushNotes(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  first: boolean,
  noteAnchor: string | undefined,
  notes: Infer<typeof noteHandles> | undefined,
) {
  if (
    !(
      (first || row.hookContinue) &&
      (row.notesPending || row.hookContinue) &&
      !awaitingApprovalResults(row)
    )
  )
    return;
  if (!notes) throw new Error("NOTE_HANDLES_REQUIRED");

  const continuation =
    row.hookContinue && row.inboxId ? await ctx.db.get("inbox", row.inboxId) : null;
  const [anchor] = (await ctx.runQuery(notes.getMessages as FunctionHandle<"query">, {
    messageIds: [noteAnchor],
  })) as (MessageDoc | null)[];
  if (!anchor || anchor.threadId !== row.threadId) throw new Error("CONTROL_ANCHOR_MISSING");

  // User/result prompts already have a fresh integer order; append notes to
  // the preceding order, after prior history and before ALL claimed work.
  // A resumed tool result stays in its call's order, so append after it.
  await claimNotes(
    ctx,
    row,
    notes,
    continuation || anchor.message?.role !== "user" ? anchor.order : anchor.order - 1,
    continuation ?? undefined,
  );
}

/** Publish the running state for this slice, retire the recovery check and
 * arm the slice watchdog (`turns.failures.stalled`), recorded on the row so only
 * disarmSlice clears it. */
async function markRunning(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  first: boolean,
  args: ClaimArgs,
) {
  await ctx.db.patch("assignments", row._id, {
    turnStatus: "running",
    hookContinue: false,
    lastSlice: args.sliceId,
    inboxId: undefined,
  });
  await disarmRecovery(ctx, row);

  const watchdogId = await ctx.scheduler.runAfter(
    LIMITS.executionWatchdogMs,
    internal.turns.failures.stalled,
    {
      assignmentId: args.assignmentId,
      turnToken: args.turnToken,
      sliceId: args.sliceId ?? args.turnToken,
    },
  );
  await ctx.db.patch("assignments", row._id, { watchdogId });
  row.watchdogId = watchdogId;
}

/** Whether this is the agent's first slice in the run (hooks' `isRunStart`).
 * On a run start, set the agent's started bit and, when the host routes the
 * model, take routing ownership (hooks/routing.ts). */
async function markRunStart(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  budget: Doc<"runs"> | null,
  { agentIndex, routeModel }: ClaimArgs,
) {
  if (agentIndex !== undefined) assertAgentIndex(agentIndex);

  const bit = 1n << BigInt(agentIndex ?? 0);
  const isRunStart = !!budget && (budget.startedAgents & bit) === 0n;
  if (budget && isRunStart)
    await ctx.db.patch("runs", budget._id, {
      startedAgents: BigInt.asIntN(LIMITS.agents, budget.startedAgents | bit),
      ...(routeModel
        ? { routingAgents: BigInt.asIntN(LIMITS.agents, budget.routingAgents | bit) }
        : {}),
    });
  if (budget && isRunStart && routeModel) {
    await ctx.db.patch("assignments", row._id, { routingAgentIndex: agentIndex ?? 0 });
    row.routingAgentIndex = agentIndex ?? 0;
  }
  return isRunStart;
}

/** A child's claim also needs its live delegation and root. The first slice
 * marks the run started and clears the previous turn's result candidates. */
async function claimChild(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  first: boolean,
  claim: Claim,
): Promise<Claim | null> {
  const run = await runById(ctx, row.childRunId!);
  const root = row.rootAssignmentId ? await ctx.db.get("assignments", row.rootAssignmentId) : null;
  if (!run || !root || (run.status !== "queued" && run.status !== "running")) {
    // A launch without a resolvable run is a corrupt state; escalate rather
    // than generate against an untrackable child.
    await disarmSlice(ctx, row);
    await failChild(ctx, row, "EXECUTION_AMBIGUOUS");
    await markRecoveryRequired(ctx, row, "EXECUTION_AMBIGUOUS");
    return null;
  }

  if (first)
    await ctx.db.patch("subagentRuns", run._id, {
      childResultMessageId: undefined,
      lastTurnResult: undefined,
      status: "running",
      startedAt: run.startedAt ?? Date.now(),
      events: appendEvent(run.events, "started", Date.now(), null),
    });

  return {
    ...claim,
    subagent: {
      runId: run.runId,
      agent: run.agent,
      rootAgent: root.agent,
      actorAgent: run.actorAgent,
      subject: root.subject,
      rootAssignmentId: root._id,
      rootThreadId: root.threadId,
      childThreadId: row.threadId,
      deliveryToken: run.deliveryToken,
    },
  };
}
