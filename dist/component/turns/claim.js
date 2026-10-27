/**
 * `turns.slices.claim`: the host action's admission to run ONE paid model slice.
 *
 * The first slice of a queued turn consumes its reserved inbox head (and any
 * consecutive results of the same run), flushes posted notes into native
 * history, marks the turn running and arms the slice watchdog. Later slices
 * of the same turn need a fresh slice id while the turn is between slices.
 * The claim also records run start and, for a
 * child, marks its delegation running. It returns the execution scope the
 * action generates under. Touches `assignments`, `inbox`, `runs` and
 * `subagentRuns`; notes go through hooks/notes.ts.
 */
import { approvalBlocked } from "../approvals.js";
import { v } from "convex/values";
import { internal } from "../_generated/api.js";
import { scope, turnOrigin as vTurnOrigin } from "../schema.js";
import { runSettings, resolveRunSettings, sliceWatchdogMs, turnStepLimit, } from "../run_settings.js";
import { readyRowLimit } from "../limits.js";
import { claimNotes, noteHandles } from "../hooks/notes.js";
import { firstReady } from "./inbox.js";
import { appendEvent, runById } from "../subagents/runs.js";
import { disarmRecovery } from "./recovery.js";
import { disarmSlice } from "./boundaries.js";
import { failChild, finishTurn, markRecoveryRequired } from "./finish.js";
import { awaitingApprovalResults } from "./pause.js";
import { isAsking } from "./wake.js";
export const claimArgs = {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    sliceId: v.optional(v.string()),
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
    turn: v.number(),
    cancellationEpoch: v.number(),
    turnOrigin: vTurnOrigin,
    subagent: v.union(v.null(), v.object({
        runId: v.string(),
        agent: v.string(),
        rootAgent: v.string(),
        actorAgent: v.string(),
        subject: v.string(),
        rootAssignmentId: v.string(),
        rootThreadId: v.string(),
        childThreadId: v.string(),
        deliveryToken: v.string(),
    })),
});
/** Claim the next slice of `turnToken`, or return null when this call may not
 * run one (stale token, cancelled, paused for approvals or a question, a
 * replayed slice id, or a corrupt child launch, which is escalated). */
export async function claimSlice(ctx, args) {
    const { assignmentId, turnToken, sliceId } = args;
    const row = await ctx.db.get("assignments", assignmentId);
    if (!row || row.cancelled || approvalBlocked(row) || row.turnToken !== turnToken)
        return null;
    // An open question is a valid pause, never corrupt execution state. This
    // guard also protects repeated/stale dispatches before any inbox deletion.
    if (await isAsking(ctx, row))
        return null;
    const first = row.turnStatus === "queued";
    if (!first &&
        // A running turn without a watchdog is between slices: continueTurn
        // disarmed it, and only a fresh slice id may claim the next one.
        !(row.turnStatus === "running" && !row.watchdogId && sliceId && row.lastSlice !== sliceId))
        return null;
    const resume = first && row.inboxId === row.turnReport?.resumeInboxId;
    const noteAnchor = first && row.inboxId ? await consumeHead(ctx, row) : row.promptMessageId;
    const budget = row.runId ? await ctx.db.get("runs", row.runId) : null;
    const settings = budget?.settings?.find((entry) => entry.agent === row.agent)?.settings ?? resolveRunSettings();
    const maxMessages = turnStepLimit(settings, row.limits.slicesPerTurn);
    // Approval resumes mint a new execution token, not a new step allowance.
    // Decide BEFORE flushNotes: an exhausted turn must not save notes
    // natively and then end with SLICE_LIMIT.
    if ((!first || resume) && (row.modelSteps ?? 0) >= maxMessages)
        return finishExhausted(ctx, row, turnToken);
    await flushNotes(ctx, row, first, noteAnchor, args.notes);
    if (first && !resume)
        row.turnReport = {
            promptMessageId: row.promptMessageId,
            messageIds: [],
            maxMessages,
        };
    await markRunning(ctx, row, first && !resume, args, settings);
    const modelId = budget?.models?.[row.agent];
    await markRunStarted(ctx, row, budget);
    const claim = {
        assignmentId,
        threadId: row.threadId,
        subject: row.subject,
        agent: row.agent,
        promptMessageId: row.promptMessageId,
        requestMessageId: row.turnReport.promptMessageId,
        runId: row.runId,
        modelId,
        settings,
        isTurnStart: first,
        turn: row.nextTurn,
        cancellationEpoch: row.cancellationEpoch,
        turnOrigin: row.turnOrigin,
        subagent: null,
    };
    return row.childRunId ? claimChild(ctx, row, first, claim) : claim;
}
/** End a turn whose step allowance is spent with SLICE_LIMIT, before any
 * native write. A later slice can reach this after an approval resume spent
 * the last step: the host Workflow allows `slicesPerTurn` slices per
 * execution, but the resume keeps the turn's `modelSteps`. The consumed
 * resume head is cleared; posted notes stay pending for the next turn. */
async function finishExhausted(ctx, row, turnToken) {
    await ctx.db.patch("assignments", row._id, {
        turnStatus: "running",
        inboxId: undefined,
    });
    await finishTurn(ctx, { assignmentId: row._id, turnToken, errorCode: "SLICE_LIMIT" });
    return null;
}
/** Delete the reserved head and, for result/note/parent work, merge the
 * consecutive ready rows of the same run. Returns the note anchor: the native
 * message after which pending notes are placed. */
async function consumeHead(ctx, row) {
    const head = await ctx.db.get("inbox", row.inboxId);
    if (!head)
        return row.promptMessageId;
    const noteAnchor = head.messageId;
    await consumeReady(ctx, head);
    // A progress/result-origin turn can pause with kind="result". Keep its
    // decided approval continuation anchored to the response until generation
    // commits the approved tool results; merging a later note would skip them.
    if (head._id === row.approvals?.inboxId && awaitingApprovalResults(row))
        return noteAnchor;
    if (head.kind !== "result" && head.kind !== "note" && head.kind !== "parent")
        return noteAnchor;
    return mergeConsecutive(ctx, row, head, noteAnchor);
}
/** Merge consecutive ready results/notes from one run without crossing a user
 * prompt. At most queueLength + reserved answer/head rows are examined. Each
 * row is metadata only; no native content or assignment rereads per iteration.
 * The combined claim, including note flushes, stays within the bounded native
 * note allowance documented in hooks/notes.ts. */
async function mergeConsecutive(ctx, row, head, noteAnchor) {
    const bound = readyRowLimit(row.limits) - 1;
    for (let count = 0; count < bound; count++) {
        const item = await firstReady(ctx, row._id);
        if (!item || item.runId !== head.runId || item.kind === "user")
            break;
        await consumeReady(ctx, item);
        row.promptMessageId = item.messageId;
        row.queuedMessages -= 1;
    }
    await ctx.db.patch("assignments", row._id, {
        promptMessageId: row.promptMessageId,
        queuedMessages: row.queuedMessages,
    });
    return noteAnchor;
}
/** Progress notes retain only exact-id origin metadata after consumption, like
 * saved hook notes. passive=false excludes them from ready and raw-note ranges. */
async function consumeReady(ctx, item) {
    if (item.kind === "note" && item.from)
        await ctx.db.patch("inbox", item._id, { passive: false });
    else
        await ctx.db.delete("inbox", item._id);
}
/** Flush posted notes only at a turn claim with no decided approvals still
 * awaiting committed results; otherwise retain them for the next safe claim.
 * Agent 0.7.7 src/approvals.ts:67-79 saves only approval responses, even for
 * denials; both outcomes get results during continuation generation. Native
 * result saves retire these recorded approvals, while answer removes its
 * deferred call atomically with the result. Never scan native history or
 * drain notes at ordinary tool-step slices.
 */
async function flushNotes(ctx, row, first, noteAnchor, notes) {
    if (!first || !row.notesPending || awaitingApprovalResults(row))
        return;
    if (!notes)
        throw new Error("NOTE_HANDLES_REQUIRED");
    const [anchor] = (await ctx.runQuery(notes.getMessages, {
        messageIds: [noteAnchor],
    }));
    if (!anchor || anchor.threadId !== row.threadId)
        throw new Error("CONTROL_ANCHOR_MISSING");
    // User/result prompts already have a fresh integer order; append notes to
    // the preceding order, after prior history and before ALL claimed work.
    // A resumed tool result stays in its call's order, so append after it.
    await claimNotes(ctx, row, notes, anchor.message?.role !== "user" ? anchor.order : anchor.order - 1);
}
/** Publish the running state for this slice, retire the recovery check and
 * arm the slice watchdog (`turns.failures.stalled`), recorded on the row so only
 * disarmSlice clears it. */
async function markRunning(ctx, row, first, args, settings) {
    await ctx.db.patch("assignments", row._id, {
        turnStatus: "running",
        turnReport: row.turnReport,
        modelSteps: first ? 1 : (row.modelSteps ?? 0) + 1,
        lastSlice: args.sliceId,
        inboxId: undefined,
    });
    await disarmRecovery(ctx, row);
    const watchdogId = await ctx.scheduler.runAfter(sliceWatchdogMs(settings), internal.turns.failures.stalled, {
        assignmentId: args.assignmentId,
        turnToken: args.turnToken,
        sliceId: args.sliceId ?? args.turnToken,
    });
    await ctx.db.patch("assignments", row._id, { watchdogId });
    row.watchdogId = watchdogId;
}
/** Root lifecycle belongs to the accepted run; hook model choices never do. */
async function markRunStarted(ctx, row, budget) {
    if (budget && !row.childRunId)
        await ctx.db.patch("runs", budget._id, {
            startedAt: budget.startedAt ?? Date.now(),
            turnEndedAt: undefined,
            errorCode: null,
        });
}
/** A child's claim also needs its live delegation and root. The first slice
 * marks the run started and clears the previous turn's result candidates. */
async function claimChild(ctx, row, first, claim) {
    const run = await runById(ctx, row.childRunId);
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
            runId: run._id,
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
