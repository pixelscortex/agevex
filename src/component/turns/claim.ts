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
import { internal } from "../_generated/api.js";
import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { scope, turnOrigin as vTurnOrigin } from "../schema.js";
import {
  runSettings,
  resolveRunSettings,
  sliceWatchdogMs,
  turnStepLimit,
  type ResolvedRunSettings,
} from "../run-settings.js";
import { LIMITS, readyRowLimit } from "../limits.js";
import { claimNotes, noteHandles } from "../hooks/notes.js";
import { firstReady } from "./inbox.js";
import { appendEvent, runById } from "../subagents/runs.js";
import { releaseReadyCohort } from "../subagents/groups.js";
import { assertAgentIndex } from "../hooks/routing.js";
import { disarmRecovery } from "./recovery.js";
import { disarmSlice } from "./boundaries.js";
import { failChild, finishTurn, markRecoveryRequired } from "./finish.js";
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
  requestMessageId: v.string(),
  runId: v.string(),
  modelId: v.optional(v.string()),
  settings: runSettings,
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
      // Tool installation reads this persisted run discriminator; side reviews
      // must never inject progress into the watched parent's execution.
      side: v.boolean(),
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

  const resume = first && row.inboxId === row.turnReport?.resumeInboxId;
  const noteAnchor = first && row.inboxId ? await consumeHead(ctx, row) : row.promptMessageId;

  const budget = row.runId ? await ctx.db.get("runs", row.runId) : null;

  const settings =
    budget?.settings?.find((entry) => entry.agent === row.agent)?.settings ?? resolveRunSettings();

  const maxMessages = turnStepLimit(settings, row.limits.slicesPerTurn);

  // Approval resumes mint a new execution token, not a new step allowance.
  // Decide BEFORE flushNotes: an exhausted turn must not save notes or a
  // staged afterTurn continuation natively and then end with SLICE_LIMIT.
  if ((!first || resume) && (row.modelSteps ?? 0) >= maxMessages)
    return finishExhausted(ctx, row, turnToken, !first && !!row.hookContinue);

  await flushNotes(ctx, row, first, noteAnchor, args.notes);

  if ((first && !resume) || row.hookContinue)
    row.turnReport = {
      promptMessageId: row.promptMessageId!,
      messageIds: [],
      maxMessages,
    };

  await markRunning(ctx, row, first && !resume, args, settings);
  const modelId = budget?.models?.[row.agent];
  const isRunStart = await markRunStart(ctx, row, budget, args);

  const claim: Claim = {
    assignmentId,
    threadId: row.threadId,
    subject: row.subject,
    agent: row.agent,
    promptMessageId: row.promptMessageId!,
    requestMessageId: row.turnReport!.promptMessageId,
    runId: row.runId!,
    modelId,
    settings,
    isTurnStart: first || !!row.hookContinue,
    isRunStart,
    turn: row.completedTurns,
    cancellationEpoch: row.cancellationEpoch,
    turnOrigin: row.turnOrigin!,
    subagent: null,
  };

  return row.childRunId ? claimChild(ctx, row, first, claim) : claim;
}

/** End a turn whose step allowance is spent with SLICE_LIMIT, before any
 * native write. A later slice can reach this after an approval resume spent
 * the last step: the host Workflow allows `slicesPerTurn` slices per
 * execution, but the resume keeps the turn's `modelSteps`. If afterTurn staged
 * a continuation (`staged`), delete its unsaved inbox row and clear
 * `hookContinue` in the same patch, as cancel and deferChildFailure do;
 * otherwise the turn would end with a dangling continuation pointer. A
 * resume's own head was already consumed by consumeHead, so only the pointer
 * is cleared. Posted notes stay pending for the next turn's claim. */
async function finishExhausted(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  turnToken: string,
  staged: boolean,
) {
  if (staged && row.inboxId) await ctx.db.delete("inbox", row.inboxId);

  await ctx.db.patch("assignments", row._id, {
    turnStatus: "running",
    inboxId: undefined,
    hookContinue: false,
  });

  await finishTurn(ctx, { assignmentId: row._id, turnToken, errorCode: "SLICE_LIMIT" });

  return null;
}

/** Delete the reserved head and, for result/note/parent work, merge the
 * consecutive ready rows of the same run. Returns the note anchor: the native
 * message after which pending notes are placed. */
async function consumeHead(ctx: MutationCtx, row: Doc<"assignments">) {
  const head = await ctx.db.get("inbox", row.inboxId!);

  if (!head) return row.promptMessageId;

  const noteAnchor = head.join?.earliestId ?? head.messageId;

  await consumeReady(ctx, head);

  // A progress/result-origin turn can pause with kind="result". Keep its
  // decided approval continuation anchored to the response until generation
  // commits the approved tool results; merging a later note would skip them.
  if (head._id === row.approvals?.inboxId && awaitingApprovalResults(row)) return noteAnchor;

  if (head.kind !== "result" && head.kind !== "note" && head.kind !== "parent") return noteAnchor;

  return mergeConsecutive(ctx, row, head, noteAnchor);
}

/** Consume the consecutive head only. Publish ready joins into that same FIFO
 * before choosing its native anchor. Otherwise an older joined result could
 * hide a consumed answer on the very next turn. Never cross another run/user turn.
 * <=100 backlog + reserved answer +50 joins + reserved head =152 rows.
 * The by_join "ready" range is scoped to this budget: <=50 members TOTAL
 * across its cohorts. Reuse loaded parent/root rows, accumulate queue/sequence
 * counters in memory and publish ONE assignment patch after the atomic drain.
 * No per-iteration assignment reads or patch reads remain, even with a full
 * previous report. Conservative metadata (KiB): <=100 run reads *16=1,600,
 * <=50 cohort members *3*4=600 (candidate/member/patch), <=152 ready rows
 * *2*1=304 (probe/delete), and <=16 fixed assignment reads/patches *34=544:
 * <=3,048 KiB <3 MiB. Together with notes' <10 MiB native/metadata allowance
 * (hooks/notes.ts), the COMBINED claim stays <13 MiB read, <4 MiB written,
 * <2,000 reads/<600 writes/<1,000 queries at all host maxima.
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
  const bound = readyRowLimit(row.limits) - 1;
  const root = row.rootAssignmentId ? await ctx.db.get("assignments", row.rootAssignmentId) : row;

  if (!root) throw new Error("ROOT_UNAVAILABLE");

  for (let count = 0; count < bound; count++) {
    await releaseReadyCohort(
      ctx,
      { assignmentId: row._id, parentRunId: head.runId },
      { parent: row, root },
    );

    const item = await firstReady(ctx, row._id);

    if (!item || item.runId !== head.runId || item.kind === "user") break;

    await consumeReady(ctx, item);
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

    row.queuedMessages -= 1;
  }

  // Publish counters once after the atomic drain. Group release updates this
  // same loaded row, so neither consumption nor release needs a per-item
  // assignment reread/patch (including Convex's implicit patch reads).
  await ctx.db.patch("assignments", row._id, {
    promptMessageId: row.promptMessageId,
    queuedMessages: row.queuedMessages,
    nextSequence: row.nextSequence,
  });

  return noteAnchor;
}

/** Progress notes retain only exact-id origin metadata after consumption, like
 * saved hook notes. passive=false excludes them from ready and raw-note ranges. */
async function consumeReady(ctx: MutationCtx, item: Doc<"inbox">) {
  if (item.kind === "note" && item.from) await ctx.db.patch("inbox", item._id, { passive: false });
  else await ctx.db.delete("inbox", item._id);
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
  settings: ResolvedRunSettings,
) {
  await ctx.db.patch("assignments", row._id, {
    turnStatus: "running",
    turnReport: row.turnReport,
    modelSteps: first ? 1 : (row.modelSteps ?? 0) + 1,
    hookContinue: false,
    lastSlice: args.sliceId,
    inboxId: undefined,
  });

  await disarmRecovery(ctx, row);

  const watchdogId = await ctx.scheduler.runAfter(
    sliceWatchdogMs(settings),
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

  if (budget && !row.childRunId)
    await ctx.db.patch("runs", budget._id, {
      startedAt: budget.startedAt ?? Date.now(),
      turnEndedAt: undefined,
      errorCode: null,
    });

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
      side: !!run.side,
    },
  };
}
