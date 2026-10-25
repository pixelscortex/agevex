import type { MessageDoc } from "@convex-dev/agent";
import type { FunctionHandle } from "convex/server";
import type { WorkflowId } from "@convex-dev/workflow";
import { rootLane, childLane, laneManager } from "./workflows.js";
import { findReceipt, armPurge } from "./ledger.js";
import { ConvexError, getConvexSize, v } from "convex/values";
import { api, internal } from "./_generated/api.js";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  activity as vActivity,
  receipt as vReceipt,
  scope,
  errorCode,
  turnOrigin as vTurnOrigin,
} from "./schema.js";
import { LIMITS, limitsValidator } from "./limits.js";
import { approvalKey, callKey, keyString, saveResponses } from "./approvals.js";
import { modelOverrides, validModelOverrides } from "./models.js";
import { sealGroups, settleIdleParent, settlementBlocked } from "./subagents.js";
import {
  recordMessages,
  recordRefs,
  messageRef,
  settleRouting,
  claimNotes,
  noteHandles,
  awaitingApprovalResults,
} from "./hooks.js";

async function existing(
  ctx: Pick<QueryCtx, "db">,
  subject: string,
  requestKey: string,
  fingerprint: string,
) {
  const row = await findReceipt(ctx, `request:${subject}`, requestKey);
  if (!row) return null;
  if (row.fingerprint !== fingerprint)
    return { status: "rejected" as const, code: "KEY_CONFLICT" as const };
  const accepted = row.result as Extract<typeof vReceipt.type, { status: "accepted" }>;
  return { ...accepted, status: "duplicate" as const };
}

export const lookupReceipt = query({
  args: { subject: v.string(), requestKey: v.string(), fingerprint: v.string() },
  returns: v.union(v.null(), vReceipt),
  handler: (ctx, args) => existing(ctx, args.subject, args.requestKey, args.fingerprint),
});

/** Preflight shares the host mutation's snapshot with its later native save.
 * Expected refusal must happen before that save: returning a receipt after a
 * write would commit an orphan prompt rather than rolling the transaction back.
 */
export const admission = query({
  args: { threadId: v.string(), subject: v.string() },
  returns: v.union(v.null(), vReceipt),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!row || row.subject !== args.subject) throw new Error("FORBIDDEN");
    if (row.turnStatus === "recovery_required")
      return {
        status: "rejected" as const,
        code: row.cancelled ? ("CANCELLED" as const) : ("RECOVERY_REQUIRED" as const),
      };
    if (row.queuedMessages >= (row.limits ?? LIMITS).queueLength)
      return { status: "rejected" as const, code: "QUEUE_FULL" as const };
    return null;
  },
});

export const assignment = query({
  args: { threadId: v.string() },
  returns: v.union(v.null(), v.object({ ...scope.fields, root: v.boolean() })),
  handler: async (ctx, { threadId }) => {
    const row = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .unique();
    // The assignment's role is fixed by how it was created: a delegated child
    // carries its childRunId, while a public root does not. Never infer this from
    // the current registration's root names. A host could later promote a
    // former child agent name to a root; that must not promote its old child
    // threads or permit public sends outside the coordinator's lifecycle.
    // Keep this extra projection local to assignment so claim's execution
    // scope and its root/child turn payload remain unchanged.
    return row
      ? {
          assignmentId: row._id,
          threadId,
          subject: row.subject,
          agent: row.agent,
          root: row.childRunId === undefined,
        }
      : null;
  },
});

/**
 * Keep exactly one check while durable inbox work has no running turn. The
 * Workflow completion callback can lag next's committed loopWaiting flag by
 * longer than a check interval, so neither that flag nor pinged owns recovery.
 * Its scheduler id lets claim/cancel/block retire the check transactionally;
 * idle deployments need no sweep and busy generations must never be re-rung.
 */
async function armRecovery(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  delayMs: number = LIMITS.reconcileIntervalMs,
) {
  if (row.recoveryAt !== undefined) return;
  const recoveryAt = Date.now() + delayMs;
  const recoveryJobId = await ctx.scheduler.runAt(recoveryAt, internal.queue.reconcile, {
    assignmentId: row._id,
    recoveryAt,
  });
  await ctx.db.patch("assignments", row._id, {
    recoveryAt,
    recoveryJobId,
    recoveryDelayMs: delayMs,
  });
}

async function disarmRecovery(ctx: MutationCtx, row: Doc<"assignments">) {
  if (row.recoveryJobId) {
    const job = await ctx.db.system.get(row.recoveryJobId);
    if (job?.state.kind === "pending") await ctx.scheduler.cancel(row.recoveryJobId);
  }
  await ctx.db.patch("assignments", row._id, {
    recoveryAt: undefined,
    recoveryJobId: undefined,
    recoveryDelayMs: undefined,
    pinged: false,
  });
}

async function needsRecovery(ctx: MutationCtx, row: Doc<"assignments">) {
  if (
    row.cancelled ||
    row.approvalBlocked ||
    row.turnStatus === "running" ||
    row.turnStatus === "recovery_required"
  )
    return false;
  return !!(await ctx.db
    .query("inbox")
    .withIndex("by_assignment_ready", (q) => q.eq("assignmentId", row._id).eq("passive", undefined))
    .first());
}

async function isAsking(ctx: MutationCtx, row: Doc<"assignments">) {
  if (!row.childRunId) return false;
  const child = await ctx.db
    .query("subagentRuns")
    .withIndex("by_run", (q) => q.eq("runId", row.childRunId!))
    .unique();
  return child?.status === "asking";
}

/**
 * Publish at most one ready inbox row and ring the thread's loop in the same
 * transaction as acceptance/delivery. Selection is metadata-only: claim keeps
 * deletion until after the host's native approval guard. The loop rechecks
 * this indexed queue after every child workflow, so early or duplicate events
 * can never create an extra model call. Its own reads use ring=false to avoid
 * waking itself forever when idle.
 */
export async function wake(ctx: MutationCtx, row: Doc<"assignments">, ring = true) {
  if (row.cancelled || row.turnStatus === "recovery_required") return;
  // Questions pause this child until an answer commits. Admission forbids
  // live descendants, so no descendant-result holding or bypass is necessary.
  if (await isAsking(ctx, row)) {
    await disarmRecovery(ctx, row);
    return;
  }
  // A full inbox may defer a join. Drain empty ready cohorts until either
  // work is published or no cohort remains, so several all-failed groups
  // sealed by the same last slice cannot strand an idle child. A child owns
  // one run budget: <=50 members TOTAL, <=50 indexed probes/releases,
  // <8 MiB metadata and <1,000 reads/writes at all host maxima. Root loops
  // keep their existing one-cohort cadence; claim drains ready FIFO work.
  const releases = row.childRunId ? (row.limits ?? LIMITS).runLaunches : 1;
  for (let i = 0; i < releases; i++) {
    if (!(await ctx.runMutation(api.subagents.releaseGroups, { assignmentId: row._id }))) break;
    row = (await ctx.db.get("assignments", row._id))!;
    if (await needsRecovery(ctx, row)) break;
  }
  // Re-evaluate R3 after every blocker-clearing wake, including failed delivery
  // and empty group release. Idle children cannot wait for nonexistent work.
  // answer/respond retain their inbox anchor until claim consumes it. That
  // anchor fences R3 even after the last approval is cleared; claim then marks
  // the turn running and clears lastTurnResult in the same transaction. Never
  // remove the anchor before publishing the resumed turn, or R3 could settle
  // the child with a provisional result before its answer is consumed.
  if (await settleIdleParent(ctx, row)) {
    await disarmRecovery(ctx, row);
    return;
  }
  // Failed/blocked child delivery also calls wake, but may leave no inbox work.
  // Such a doorbell would immediately lose its coalescing flag in
  // disarmRecovery and accumulate unconsumed events across loop rotation.
  const hasWork = await needsRecovery(ctx, row);
  if (row.turnStatus === "idle" && !row.approvalBlocked) {
    const next = await ctx.db
      .query("inbox")
      .withIndex("by_assignment_ready", (q) =>
        q.eq("assignmentId", row._id).eq("passive", undefined),
      )
      .first();
    if (next) {
      await ctx.db.patch("assignments", row._id, {
        turnStatus: "queued",
        turnToken: `${row._id}:${row.nextTurn}`,
        promptMessageId: next.messageId,
        inboxId: next._id,
        runId: next.runId,
        turnOrigin: next.kind === "result" || next.kind === "note" ? "subagent_result" : "user",
        nextTurn: row.nextTurn + 1,
        queuedMessages: row.queuedMessages - 1,
      });
    }
  }
  const manager = laneManager(!!row.childRunId, row.limits ?? LIMITS);
  if (!row.workflowId) {
    const workflowId = await manager.start(
      ctx,
      row.childRunId ? internal.workflows.childLoop : internal.workflows.rootLoop,
      {
        assignmentId: row._id,
        version: LIMITS.workflowVersion,
        ...(row.limits && row.limits.slicesPerTurn !== LIMITS.slicesPerTurn
          ? { slicesPerTurn: row.limits.slicesPerTurn }
          : {}),
      },
      {
        onComplete: row.childRunId ? internal.workflows.childDone : internal.workflows.rootDone,
        context: { assignmentId: row._id },
        startAsync: true,
      },
    );
    await ctx.db.patch("assignments", row._id, { workflowId });
  } else if (
    ring &&
    hasWork &&
    row.loopWaiting &&
    !row.pinged &&
    !row.approvalBlocked &&
    row.turnStatus !== "running"
  ) {
    await manager.sendEvent(ctx, { workflowId: row.workflowId as WorkflowId, name: "ping" });
    await ctx.db.patch("assignments", row._id, { pinged: true });
  }
  // wake may have reserved the head or started a loop; use its committed row
  // so recovery follows inbox ownership even before the first awaited ping.
  const current = (await ctx.db.get("assignments", row._id))!;
  if (await needsRecovery(ctx, current)) await armRecovery(ctx, current);
  else await disarmRecovery(ctx, current);
}

export const accept = mutation({
  args: {
    subject: v.string(),
    agent: v.string(),
    threadId: v.string(),
    requestKey: v.string(),
    fingerprint: v.string(),
    promptMessageId: v.string(),
    savedMessage: v.optional(messageRef),
    trackContext: v.optional(v.boolean()),
    runTurn: v.string(),
    limits: v.optional(limitsValidator),
    models: v.optional(modelOverrides),
  },
  returns: vReceipt,
  handler: async (ctx, args) => {
    if (args.models && !validModelOverrides(args.models)) throw new Error("INVALID_MODELS");
    const duplicate = await existing(ctx, args.subject, args.requestKey, args.fingerprint);
    if (duplicate) return duplicate;
    let row = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!row) {
      const id = await ctx.db.insert("assignments", {
        subject: args.subject,
        agent: args.agent,
        threadId: args.threadId,
        runTurn: args.runTurn,
        limits: args.limits,
        turnStatus: "idle",
        errorCode: null,
        queuedMessages: 0,
        notesPending: 0,
        nextSequence: 0,
        nextTurn: 0,
        cancellationEpoch: 0,
        cancelled: false,
      });
      row = (await ctx.db.get("assignments", id))!;
    }
    if (row.subject !== args.subject || row.agent !== args.agent) throw new Error("FORBIDDEN");
    if (args.trackContext && !row.contextMessages) {
      await ctx.db.patch("assignments", row._id, { contextMessages: [] });
      row = { ...row, contextMessages: [] };
    }
    if (row.turnStatus === "recovery_required") throw new Error("RECOVERY_REQUIRED");
    if (row.queuedMessages >= (row.limits ?? LIMITS).queueLength) throw new Error("QUEUE_LIMIT");
    if (row.cancelled) {
      await ctx.db.patch("assignments", row._id, { cancelled: false });
      row = { ...row, cancelled: false };
    }
    // queuedMessages excludes the head reserved by wake until claim deletes
    // its inbox row. Position counts that still-present row too; otherwise two
    // successive accepted messages would both report position zero.
    const position = row.queuedMessages + (row.inboxId ? 1 : 0);
    const models = args.models ?? row.models;
    const runId = await ctx.db.insert("runs", {
      models,
      launches: 0,
      hops: 0,
      cancelled: false,
    });
    await ctx.db.insert("inbox", {
      assignmentId: row._id,
      messageId: args.promptMessageId,
      sequence: row.nextSequence,
      kind: "user",
      runId,
    });
    await ctx.db.patch("assignments", row._id, {
      models,
      queuedMessages: row.queuedMessages + 1,
      nextSequence: row.nextSequence + 1,
    });
    if (args.savedMessage) await recordRefs(ctx, row, [args.savedMessage]);
    await armPurge(ctx);
    // Acceptance and the host's native prompt save share one transaction: no
    // external effect can outlive an abandoned claim, so request receipts enter
    // the same ledger already done rather than leasing an action-shaped claim.
    const receiptId = await ctx.db.insert("receipts", {
      kind: "effect",
      scope: `request:${args.subject}`,
      key: args.requestKey,
      fingerprint: args.fingerprint,
      status: "done",
      claim: crypto.randomUUID(),
      leaseUntil: Date.now(),
      expiresAt: Date.now() + LIMITS.receiptRetentionMs,
    });
    await ctx.db.patch("receipts", receiptId, {
      result: {
        assignmentId: row._id,
        threadId: args.threadId,
        receiptId,
        status: "accepted",
        position,
      },
    });
    await wake(ctx, { ...row, queuedMessages: row.queuedMessages + 1 });
    return {
      assignmentId: row._id,
      threadId: args.threadId,
      receiptId,
      status: "accepted" as const,
      position,
    };
  },
});

/**
 * Claim one model slice, not an entire retriable action. A first slice consumes
 * the reserved inbox row, while subsequent slices require both continuation
 * state and a new slice id under the same execution token. Replayed or racing
 * calls therefore cannot pay for the same slice twice. Each slice arms its own
 * watchdog; lane wait and time between completed slices do not spend it. Consecutive child results
 * share a final prompt anchor, letting native context include the whole batch.
 */
export const claim = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    sliceId: v.optional(v.string()),
    agentIndex: v.optional(v.number()),
    routeModel: v.optional(v.boolean()),
    notes: v.optional(noteHandles),
  },
  returns: v.union(
    v.null(),
    v.object({
      ...scope.fields,
      promptMessageId: v.string(),
      logicalPromptMessageId: v.string(),
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
    }),
  ),
  handler: async (ctx, { assignmentId, turnToken, sliceId, agentIndex, routeModel, notes }) => {
    const row = await ctx.db.get("assignments", assignmentId);
    if (!row || row.cancelled || row.approvalBlocked || row.turnToken !== turnToken) return null;
    // An open question is a valid pause, never corrupt execution state. This
    // guard also protects repeated/stale dispatches before any inbox deletion.
    if (await isAsking(ctx, row)) return null;
    const first = row.turnStatus === "queued";
    if (
      !first &&
      !(row.turnStatus === "running" && row.continueSlice && sliceId && row.lastSlice !== sliceId)
    )
      return null;
    let noteAnchor = row.promptMessageId;
    if (first && row.inboxId) {
      const head = await ctx.db.get("inbox", row.inboxId);
      if (head) {
        noteAnchor = head.earliestMessageId ?? head.messageId;
        await ctx.db.delete("inbox", head._id);
      }
      if (head?.kind === "result" || head?.kind === "note" || head?.kind === "parent") {
        // Consume the consecutive head only. Freeing capacity can publish an
        // already-ready join, so drain that same FIFO before choosing its native
        // anchor. Otherwise an older deferred join could hide a consumed answer
        // on the very next turn. Never cross another run/user turn.
        // <=100 backlog + reserved answer +50 joins + reserved head =152 rows.
        // The ready-group index is scoped to this budget: <=50 members TOTAL
        // across its cohorts. <=100 run metadata reads (400 KiB), <=152
        // inbox deletes/assignment patches and fixed per-iteration probes stay
        // <8 MiB, <2,000 reads/<600 writes even at all host maxima.
        // @convex-dev/agent/src/component/messages.ts:298-322 anchors native
        // context at the prompt's recorded order, rather than our inbox order.
        let newest = head.messageSequence ?? head.sequence;
        let earliest = head.earliestMessageSequence ?? newest;
        const bound = (row.limits ?? LIMITS).queueLength + (row.limits ?? LIMITS).runLaunches + 1;
        for (let count = 0; count < bound; count++) {
          await ctx.runMutation(api.subagents.releaseGroups, {
            assignmentId: row._id,
            parentRunId: head.runId,
          });
          const item = await ctx.db
            .query("inbox")
            .withIndex("by_assignment_ready", (q) =>
              q.eq("assignmentId", row._id).eq("passive", undefined),
            )
            .first();
          if (!item || item.runId !== head.runId || item.kind === "user") break;
          await ctx.db.delete("inbox", item._id);
          const order = item.messageSequence ?? item.sequence;
          const noteOrder = item.earliestMessageSequence ?? order;
          if (noteOrder < earliest) {
            earliest = noteOrder;
            noteAnchor = item.earliestMessageId ?? item.messageId;
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
      }
    }
    // Flush posted notes only at a turn claim with no decided approvals still
    // awaiting committed results; otherwise retain them for the next safe claim.
    // Agent 0.7.7 src/approvals.ts:67-79 saves only approval responses, even for
    // denials; both outcomes get results during continuation generation. Native
    // result saves retire these recorded approvals, while answer removes its
    // deferred call atomically with the result. Never scan native history or
    // drain notes at ordinary tool-step slices.
    if (
      (first || row.hookContinue) &&
      (row.notesPending || row.hookContinue) &&
      !awaitingApprovalResults(row)
    ) {
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
    await ctx.db.patch("assignments", row._id, {
      turnStatus: "running",
      continueSlice: false,
      hookContinue: false,
      ...(first
        ? {
            logicalPromptMessageId: row.promptMessageId,
          }
        : {}),
      approvals: row.approvals
        ? {
            ...row.approvals,
            requests: row.approvals.requests.map((request, index) => ({
              ...request,
              state: row.approvals!.resolved.includes(index) ? ("running" as const) : request.state,
            })),
          }
        : undefined,
      lastSlice: sliceId,
      inboxId: undefined,
    });
    await disarmRecovery(ctx, row);
    const activeSlice = sliceId ?? turnToken;
    const watchdogId = await ctx.scheduler.runAfter(
      LIMITS.executionWatchdogMs,
      internal.queue.stalled,
      {
        assignmentId,
        turnToken,
        sliceId: activeSlice,
      },
    );
    await ctx.db.patch("assignments", row._id, { watchdogId, activeSlice });
    row.watchdogId = watchdogId;
    row.activeSlice = activeSlice;
    const budget = row.runId ? await ctx.db.get("runs", row.runId) : null;
    const modelId = budget?.models?.[row.agent];
    if (
      agentIndex !== undefined &&
      (!Number.isSafeInteger(agentIndex) || agentIndex < 0 || agentIndex >= LIMITS.agents)
    )
      throw new Error("INVALID_AGENT_INDEX");
    const bit = 1n << BigInt(agentIndex ?? 0);
    const isRunStart = !!budget && ((budget.startedAgents ?? 0n) & bit) === 0n;
    if (budget && isRunStart)
      await ctx.db.patch("runs", budget._id, {
        startedAgents: BigInt.asIntN(LIMITS.agents, (budget.startedAgents ?? 0n) | bit),
        ...(routeModel
          ? { routingAgents: BigInt.asIntN(LIMITS.agents, (budget.routingAgents ?? 0n) | bit) }
          : {}),
      });
    if (budget && isRunStart && routeModel) {
      await ctx.db.patch("assignments", row._id, { routingAgentIndex: agentIndex ?? 0 });
      row.routingAgentIndex = agentIndex ?? 0;
    }
    const hooks = {
      isTurnStart: first || !!row.hookContinue,
      isRunStart,
      turn: row.completedTurns ?? 0,
    };
    const runId = row.childRunId;
    if (!runId) {
      return {
        assignmentId,
        threadId: row.threadId,
        subject: row.subject,
        agent: row.agent,
        promptMessageId: row.promptMessageId!,
        logicalPromptMessageId: first ? row.promptMessageId! : row.logicalPromptMessageId!,
        runId: row.runId!,
        modelId,
        ...hooks,
        cancellationEpoch: row.cancellationEpoch,
        turnOrigin: row.turnOrigin ?? "user",
        subagent: null,
      };
    }
    const run = await ctx.db
      .query("subagentRuns")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();
    const root = row.rootAssignmentId
      ? await ctx.db.get("assignments", row.rootAssignmentId)
      : null;
    if (!run || !root || (run.status !== "queued" && run.status !== "running")) {
      // A launch without a resolvable run is a corrupt state; escalate rather
      // than generate against an untrackable child.
      await disarmSlice(ctx, row);
      await failChild(ctx, row, "EXECUTION_AMBIGUOUS");
      await ctx.db.patch("assignments", assignmentId, {
        turnStatus: "recovery_required",
        errorCode: "EXECUTION_AMBIGUOUS",
      });
      return null;
    }
    if (first)
      await ctx.db.patch("subagentRuns", run._id, {
        childResultMessageId: undefined,
        lastTurnResult: undefined,
        status: "running",
        startedAt: run.startedAt ?? Date.now(),
        events: [
          ...run.events,
          { phase: "started" as const, at: Date.now(), errorCode: null },
        ].slice(-LIMITS.runEvents),
      });
    return {
      assignmentId,
      threadId: row.threadId,
      subject: row.subject,
      agent: row.agent,
      promptMessageId: row.promptMessageId!,
      logicalPromptMessageId: first ? row.promptMessageId! : row.logicalPromptMessageId!,
      runId: row.runId!,
      modelId,
      ...hooks,
      cancellationEpoch: row.cancellationEpoch,
      turnOrigin: row.turnOrigin ?? "user",
      subagent: {
        runId: run.runId,
        agent: run.agent,
        rootAgent: run.rootAgent,
        actorAgent: run.actorAgent,
        subject: run.subject,
        rootAssignmentId: root._id,
        rootThreadId: root.threadId,
        childThreadId: row.threadId,
        deliveryToken: run.deliveryToken,
      },
    };
  },
});

export const finish = mutation({
  args: { assignmentId: v.id("assignments"), turnToken: v.string(), errorCode },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.cancelled || row.turnToken !== args.turnToken || row.turnStatus !== "running")
      return null;
    await disarmSlice(ctx, row);
    await sealGroups(ctx, row);
    if (args.errorCode && (await deferChildFailure(ctx, row, args.errorCode))) return null;
    if (args.errorCode) {
      await failChild(ctx, row, args.errorCode);
      await ctx.db.patch("assignments", row._id, {
        turnStatus: "recovery_required",
        errorCode: args.errorCode,
      });
    } else {
      await ctx.db.patch("assignments", row._id, {
        turnStatus: "idle",
        turnToken: undefined,
        promptMessageId: undefined,
      });
      await wake(ctx, { ...row, turnStatus: "idle" });
    }
    return null;
  },
});

async function disarmSlice(ctx: MutationCtx, row: Doc<"assignments">) {
  // Every terminal fence, including watchdog/cancel and native approval exits,
  // releases routing even if the action never reaches its finally block.
  await settleRouting(ctx, row);
  if (row.watchdogId) {
    const job = await ctx.db.system.get(row.watchdogId);
    // A watchdog firing now already owns its scheduled job. Clear the slice
    // fence without attempting to cancel that in-progress detector itself.
    if (job?.state.kind === "pending") await ctx.scheduler.cancel(row.watchdogId);
  }
  await ctx.db.patch("assignments", row._id, { watchdogId: undefined, activeSlice: undefined });
}

/** A failed turn also obeys the run fence. A later descendant delivery may
 * continue the run, but this failed paid generation is never retried. Clear its
 * token so any late native writes lose ownership before waking queued work.
 */
async function deferChildFailure(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  code: Doc<"assignments">["errorCode"] = "EXECUTION_AMBIGUOUS",
) {
  if (!row.childRunId || !(await settlementBlocked(ctx, row))) return false;
  // Persist the failed last-turn outcome before releasing its execution token.
  // Escalation obeys the same fence, so it cannot settle over pending work.
  await failChild(ctx, row, code);
  await disarmSlice(ctx, row);
  await sealGroups(ctx, row);
  // A continuation staged by afterTurn (continueAdmission) is consumed only by
  // the next slice's claim, which this failure just forfeited. Left behind, the
  // row stays out of the ready range and wake would overwrite inboxId with the
  // next ready row, orphaning it; cancel would then delete that ready row twice
  // (once as the "staged continuation", once in its ready loop) and throw.
  // Delete it here, as cancel does, and drop both pointers.
  if (row.hookContinue && row.inboxId) await ctx.db.delete("inbox", row.inboxId);
  await ctx.db.patch("assignments", row._id, {
    turnStatus: "idle",
    turnToken: undefined,
    promptMessageId: undefined,
    continueSlice: false,
    ...(row.hookContinue ? { hookContinue: false, inboxId: undefined } : {}),
    errorCode: null,
  });
  await wake(ctx, (await ctx.db.get("assignments", row._id))!);
  return true;
}

/** All terminal child failures share the idempotent settlement/notification path. */
async function failChild(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  code: Doc<"assignments">["errorCode"],
) {
  if (!row.childRunId) return null;
  await ctx.runMutation(internal.subagents.escalate, { runId: row.childRunId, errorCode: code });
  return null;
}

async function markAmbiguous(ctx: MutationCtx, assignmentId: Id<"assignments">, turnToken: string) {
  const row = await ctx.db.get("assignments", assignmentId);
  if (
    row &&
    !row.cancelled &&
    row.turnToken === turnToken &&
    (row.turnStatus === "queued" || row.turnStatus === "running")
  ) {
    // wake already removed the reserved head from queuedMessages. A dispatch
    // that fails before claim must retire that exact row without decrementing
    // again; otherwise the fence mistakes it for pending work and wake reserves
    // the same head a second time. The token/status fence makes duplicates no-ops.
    if (row.turnStatus === "queued" && row.inboxId) {
      const head = await ctx.db.get("inbox", row.inboxId);
      if (head) await ctx.db.delete("inbox", head._id);
      await ctx.db.patch("assignments", row._id, { inboxId: undefined });
      row.inboxId = undefined;
    }
    if (await deferChildFailure(ctx, row)) return null;
    await ctx.db.patch("assignments", row._id, {
      turnStatus: "recovery_required",
      errorCode: "EXECUTION_AMBIGUOUS",
    });
    await disarmSlice(ctx, row);
    await disarmRecovery(ctx, row);
    await failChild(ctx, row, "EXECUTION_AMBIGUOUS");
  }
  return null;
}

export const ambiguous = mutation({
  args: { assignmentId: v.id("assignments"), turnToken: v.string() },
  returns: v.null(),
  handler: (ctx, args) => markAmbiguous(ctx, args.assignmentId, args.turnToken),
});

export const stalled = internalMutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    sliceId: v.optional(v.string()),
  },
  returns: v.null(),
  // Detection only: never reassign an expired token or replay a generation.
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (
      row &&
      !row.cancelled &&
      row.turnToken === args.turnToken &&
      row.turnStatus === "running" &&
      row.activeSlice === (args.sliceId ?? args.turnToken)
    ) {
      if (await deferChildFailure(ctx, row)) return null;
      await ctx.db.patch("assignments", row._id, {
        turnStatus: "recovery_required",
        errorCode: "EXECUTION_AMBIGUOUS",
      });
      await disarmSlice(ctx, row);
      await failChild(ctx, row, "EXECUTION_AMBIGUOUS");
    }
    return null;
  },
});

/** `replayed` is true when an identical retry was served from the response
 * receipt, so a host can tell a first decision from a replay (e.g. to record
 * single-use consent only once). */
const vResponseResult = v.object({ messageId: v.string(), replayed: v.boolean() });

export const activity = query({
  args: { threadId: v.string(), subject: v.string() },
  returns: vActivity,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (!row || row.subject !== args.subject) throw new Error("FORBIDDEN");
    return {
      assignmentId: row._id,
      threadId: row.threadId,
      agent: row.agent,
      assignmentStatus: "open" as const,
      turnStatus: row.turnStatus,
      queuedMessages: row.queuedMessages,
      errorCode: row.errorCode,
      runId: row.runId,
      subagents: {
        active: row.activeRuns ?? 0,
        history: row.historyRuns ?? 0,
        total: (row.activeRuns ?? 0) + (row.historyRuns ?? 0),
      },
    };
  },
});

/** Read execution metadata outside the Workflow journal; only ids cross steps. */
export const execution = query({
  args: { assignmentId: v.id("assignments") },
  handler: (ctx, args) => ctx.db.get("assignments", args.assignmentId),
});

export const next = internalMutation({
  args: { assignmentId: v.id("assignments") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { assignmentId }): Promise<string | null> => {
    let row = await ctx.db.get("assignments", assignmentId);
    if (!row || row.cancelled || row.turnStatus === "recovery_required") return null;
    if (row.approvalBlocked) {
      // The loop awaits ping for every null result, including approval pauses.
      // Publish that wait before returning so a fresh send can ring the loop
      // after the native approval response is recorded. No journal step changes.
      await ctx.db.patch("assignments", row._id, { pinged: false, loopWaiting: true });
      return null;
    }
    // next runs after the previous ping was consumed, or after a turn ended.
    // Keep this in the existing mutation so the versioned step order is fixed.
    await ctx.db.patch("assignments", row._id, { pinged: false, loopWaiting: false });
    if (row.turnStatus === "idle") {
      await wake(ctx, row, false);
      row = await ctx.db.get("assignments", assignmentId);
    }
    if (row?.turnStatus === "queued") return row.turnToken!;
    if (row) await ctx.db.patch("assignments", row._id, { loopWaiting: true });
    return null;
  },
});

/** A single transactional fence around the native mutation, including its save.
 * Checking in the action before calling a native mutation leaves a cancel race;
 * nested Convex mutations share this transaction, so cancellation wins or the
 * write commits before cancellation. Host tool mutations use this same path.
 */
export const write = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    cancellationEpoch: v.number(),
    handle: v.string(),
    args: v.any(),
    rejectStale: v.optional(v.boolean()),
    nativeStream: v.optional(v.string()),
    trackUsage: v.optional(v.boolean()),
    deferredTools: v.optional(v.array(v.string())),
    nativeMessages: v.optional(
      v.object({
        getMessages: v.string(),
        finalizeMessage: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    // A child can settle immediately before cancel, while its source action
    // still owns the turn token. It no longer occupies an active slot, so
    // cancel need not visit its assignment. The root epoch still fences every
    // late native/tool write: two <=32 KiB assignment reads plus one <=4 KiB
    // child-run reference (<72 KiB), no traversal.
    const root = row?.rootAssignmentId
      ? await ctx.db.get("assignments", row.rootAssignmentId)
      : null;
    const run = row?.childRunId
      ? await ctx.db
          .query("subagentRuns")
          .withIndex("by_run", (q) => q.eq("runId", row.childRunId!))
          .unique()
      : null;
    const rootRevoked =
      !!row?.childRunId &&
      (!root || root.cancelled || !run || run.rootCancellationEpoch !== root.cancellationEpoch);
    if (
      !row ||
      row.cancelled ||
      rootRevoked ||
      row.turnStatus !== "running" ||
      row.turnToken !== args.executionId ||
      row.cancellationEpoch !== args.cancellationEpoch
    ) {
      const pending = row?.pendingGeneration;
      if (
        pending &&
        pending.executionId === args.executionId &&
        pending.epoch === args.cancellationEpoch &&
        pending.finalizeMessage === args.handle &&
        args.args?.messageId === pending.messageId &&
        args.args?.result?.status === "failed"
      )
        return ctx.runMutation(internal.cancellation.close, {
          assignmentId: args.assignmentId,
          executionId: args.executionId,
          epoch: args.cancellationEpoch,
          messageId: pending.messageId,
        });
      if (args.rejectStale) throw new ConvexError({ code: "CANCELLED" });
      return null; // Agent's asynchronous void abort listeners must resolve.
    }
    const deferredTools = new Set(args.deferredTools ?? []);
    if (
      deferredTools.size > LIMITS.approvalsPerPause ||
      [...deferredTools].some((name) => !name || name.length > LIMITS.requestKeyLength)
    )
      throw new Error("INVALID_DEFERRED_TOOLS");
    if (args.nativeMessages) {
      const messages = args.args.messages as { message?: MessageDoc["message"] }[];
      const count = messages.reduce((total, { message }) => {
        if (message?.role !== "assistant" || !Array.isArray(message.content)) return total;
        const content = message.content;
        return (
          total +
          content.filter(
            (part) =>
              part.type === "tool-approval-request" ||
              (part.type === "tool-call" &&
                !part.providerExecuted &&
                deferredTools.has(part.toolName) &&
                !content.some(
                  (candidate) =>
                    candidate.type === "tool-approval-request" &&
                    candidate.toolCallId === part.toolCallId,
                )),
          ).length
        );
      }, 0);
      if (count > LIMITS.approvalsPerPause) {
        // Reject the entire step BEFORE its native save: overflow approvals must
        // never exist without bounded coordination references. Return null so
        // this typed failure commits; throwing would roll it back. The SDK
        // stops on the rejected save, and its stale finish cannot overwrite it.
        await disarmSlice(ctx, row);
        await disarmRecovery(ctx, row);
        if (await deferChildFailure(ctx, row, "APPROVAL_LIMIT")) return null;
        await failChild(ctx, row, "APPROVAL_LIMIT");
        await ctx.db.patch("assignments", row._id, {
          turnStatus: "recovery_required",
          errorCode: "APPROVAL_LIMIT",
          turnToken: undefined,
          continueSlice: false,
        });
        return null;
      }
    }
    const result = await ctx.runMutation(args.handle as FunctionHandle<"mutation">, args.args);
    if (args.nativeMessages) {
      // Agent 0.7.7 addMessages returns the actual pending document, including
      // its id (vercel/client/saveInputMessages.ts). Record only coordination
      // metadata in the SAME transaction as the native placeholder creation.
      const messages = (result as { messages: MessageDoc[] }).messages;
      await recordMessages(ctx, row, messages);
      const modelStep = args.trackUsage
        ? messages.find((message) => message.usage && message.status === "success")
        : undefined;
      if (modelStep)
        await ctx.db.patch("assignments", row._id, {
          modelStep: { messageId: String(modelStep._id), stepOrder: modelStep.stepOrder },
        });
      // Claiming a continuation never consumes a decision: cancel can still
      // win while the tool/provider awaits I/O. Retire only with its native save.
      // Agent 0.7.7 src/vercel/client/prepareApprovalContext.ts:23-30 treats a
      // subsequent assistant response as consumption of provider-owned decisions,
      // even without a tool-result. Pending placeholders are not responses.
      if (row.approvals) {
        const resulted = new Set<string>();
        for (const message of messages) {
          if (message.message?.role !== "tool" || !Array.isArray(message.message.content)) continue;
          for (const part of message.message.content)
            if (part.type === "tool-result") resulted.add(await approvalKey(part.toolCallId));
        }
        const providerConsumed = messages.some(
          (message) =>
            message.message?.role === "assistant" &&
            message.status === "success" &&
            Array.isArray(message.message.content),
        );
        const remaining = row.approvals.requests
          .map((request, index) => ({ request, resolved: row.approvals!.resolved.includes(index) }))
          .filter(
            ({ request }) =>
              !(providerConsumed && request.providerExecuted && request.state === "running") &&
              !resulted.has(keyString(request.toolCallKey)),
          );
        row.approvals = remaining.length
          ? {
              ...row.approvals,
              requests: remaining.map(({ request }) => request),
              resolved: remaining.flatMap(({ resolved }, index) => (resolved ? [index] : [])),
            }
          : undefined;
        await ctx.db.patch("assignments", row._id, { approvals: row.approvals });
      }
      if (row.childRunId) {
        const run = await ctx.db
          .query("subagentRuns")
          .withIndex("by_run", (q) => q.eq("runId", row.childRunId!))
          .unique();
        const finals = messages.filter(
          (message) =>
            message.message?.role === "assistant" &&
            message.status === "success" &&
            message.text?.trim(),
        );
        const final = finals[finals.length - 1];
        if (run && final)
          await ctx.db.patch("subagentRuns", run._id, { childResultMessageId: final._id });
      }
      const pending = messages.filter((message) => message.status === "pending");
      if (pending.length > 1) throw new Error("MULTIPLE_PENDING_GENERATIONS");
      if (pending.length)
        await ctx.db.patch("assignments", row._id, {
          pendingGeneration: {
            messageId: pending[0]._id,
            executionId: args.executionId,
            epoch: args.cancellationEpoch,
            ...args.nativeMessages,
          },
        });
      else if (row.pendingGeneration?.messageId === args.args?.pendingMessageId)
        await ctx.db.patch("assignments", row._id, { pendingGeneration: undefined });
      const requests: NonNullable<Doc<"assignments">["approvals"]>["requests"] = [];
      let count = 0;
      let requestMessageId: string | undefined;
      for (const message of messages) {
        if (message.message?.role !== "assistant" || !Array.isArray(message.message.content))
          continue;
        const content = message.message.content;
        for (const part of content) {
          if (part.type !== "tool-approval-request") continue;
          requestMessageId ??= message._id;
          count++;
          const key = await approvalKey(part.approvalId);
          if (requests.some((request) => request.key === key)) continue;
          requests.push({
            key,
            messageId: message._id,
            toolCallKey: await callKey(part.toolCallId),
            providerExecuted: content.some(
              (call) =>
                call.type === "tool-call" &&
                call.toolCallId === part.toolCallId &&
                call.providerExecuted === true,
            ),
          });
        }
      }
      // Only calls from declared no-execute tools can become host-answerable.
      // Record hashes + the exact native message id in the SAME transaction as
      // that assistant save. Payload/tool name stays in Agent's document.
      for (const message of messages) {
        if (message.message?.role !== "assistant" || !Array.isArray(message.message.content))
          continue;
        const content = message.message.content;
        for (const part of content) {
          if (
            part.type !== "tool-call" ||
            part.providerExecuted ||
            !deferredTools.has(part.toolName) ||
            content.some(
              (candidate) =>
                candidate.type === "tool-approval-request" &&
                candidate.toolCallId === part.toolCallId,
            )
          )
            continue;
          const key = await approvalKey(part.toolCallId);
          const alreadyResulted = messages.some(
            (doc) =>
              doc.message?.role === "tool" &&
              doc.message.content.some(
                (result) => result.type === "tool-result" && result.toolCallId === part.toolCallId,
              ),
          );
          if (
            alreadyResulted ||
            requests.some((request) => request.key === key && request.deferred)
          )
            continue;
          // The cancellation result repeats the native ids. Refuse an id/name
          // envelope that cannot be settled in one bounded cleanup document.
          if (
            getConvexSize({ toolCallId: part.toolCallId, toolName: part.toolName }) +
              LIMITS.nativeEnvelopeBytes >
            LIMITS.cleanupMessageBytes
          )
            throw new Error("DEFERRED_CALL_TOO_LARGE");
          requests.push({
            key,
            messageId: message._id,
            toolCallKey: await callKey(part.toolCallId),
            providerExecuted: false,
            deferred: true,
          });
          requestMessageId ??= message._id;
          count++;
        }
      }
      if (count) {
        await disarmSlice(ctx, row);
        await disarmRecovery(ctx, row);
        if (row.approvalBlocked) throw new Error("APPROVAL_ALREADY_PENDING");
        if (row.approvals?.requests.length) throw new Error("APPROVAL_RESULTS_MISSING");
        // This is the suspended turn's control continuation, so it uses the
        // reserved head/approval slot even when ordinary ready work is full.
        // answer/respond update this exact row instead of admitting more work;
        // 100 ordinary rows + one parent-answer slot + this continuation remain
        // within the 102-row per-assignment cancel bound in limits.ts.
        // The response continuation must precede unrelated queued sends.
        const head = await ctx.db
          .query("inbox")
          .withIndex("by_assignment_ready", (q) =>
            q.eq("assignmentId", row._id).eq("passive", undefined),
          )
          .first();
        const inboxId = await ctx.db.insert("inbox", {
          assignmentId: row._id,
          runId: row.runId!,
          messageId: requestMessageId!,
          sequence: head ? head.sequence - 1 : row.nextSequence,
          kind: row.turnOrigin === "subagent_result" ? "result" : "user",
        });
        // Commit the block with the native request, even if the action dies
        // immediately after this mutation. No later action owns this fact.
        await ctx.db.patch("assignments", row._id, {
          approvalBlocked: true,
          approvals: {
            inboxId,
            requests,
            resolved: [],
            epoch: row.cancellationEpoch,
            getMessages: args.nativeMessages.getMessages,
            addMessages: args.handle,
          },
          turnStatus: "idle",
          turnToken: undefined,
          promptMessageId: undefined,
          inboxId: undefined,
          continueSlice: false,
          queuedMessages: row.queuedMessages + 1,
          nextSequence: row.nextSequence + 1,
        });
      }
    }
    if (args.nativeStream) {
      const pending = row.pendingGeneration;
      if (
        !pending ||
        pending.executionId !== args.executionId ||
        pending.epoch !== args.cancellationEpoch
      )
        throw new Error("UNTRACKED_GENERATION_STREAM");
      await ctx.db.patch("assignments", row._id, {
        pendingGeneration: {
          ...pending,
          stream: { id: result as string, abort: args.nativeStream },
        },
      });
    }
    return result;
  },
});

/**
 * Native responses commit once with their receipt, so a lost host response can
 * replay even after the pending-call reference has been consumed. Hash the
 * tuple and payload instead of copying potentially near-1 MiB native ids or
 * answer/reason text into the ledger; JSON framing keeps tuple parts distinct.
 * The indexed lookup reads one <=64 KiB result plus fixed-size metadata. Saving
 * adds one expiry-head read and one receipt write of the same bound: <256 KiB
 * total additional I/O, independent of the <=16 calls in a pause. Together with
 * answer's <13 MiB native/readiness budget below, this remains <13.25 MiB.
 */
async function responseReceipt(
  ctx: MutationCtx,
  scope: "answer" | "respond",
  threadId: string,
  callId: string,
  payload: string,
) {
  const key = await approvalKey(JSON.stringify([threadId, callId]));
  const fingerprint = await approvalKey(payload);
  const receipt = await findReceipt(ctx, scope, key);
  if (receipt && receipt.fingerprint !== fingerprint)
    throw new ConvexError({ code: "KEY_CONFLICT" });
  return { scope, key, fingerprint, messageId: receipt?.result as string | undefined };
}

async function saveResponseReceipt(
  ctx: MutationCtx,
  receipt: { scope: string; key: string; fingerprint: string },
  messageId: string,
) {
  // Keep the same result bound and seven-day purge lifecycle as tool/request
  // receipts. The saved native message remains the only copy of the payload.
  if (getConvexSize(messageId) > LIMITS.receiptResultBytes) throw new Error("RESULT_TOO_LARGE");
  await armPurge(ctx);
  await ctx.db.insert("receipts", {
    kind: "effect",
    scope: receipt.scope,
    key: receipt.key,
    fingerprint: receipt.fingerprint,
    status: "done",
    claim: crypto.randomUUID(),
    leaseUntil: Date.now(),
    result: messageId,
    expiresAt: Date.now() + LIMITS.receiptRetentionMs,
  });
}

/** Approval responses MUST go through the authorized respond endpoint. A
 * response saved directly through Agent is not seen by this runtime.
 */
export const respond = mutation({
  args: {
    assignmentId: v.id("assignments"),
    subject: v.string(),
    approvalId: v.string(),
    approved: v.boolean(),
    reason: v.optional(v.string()),
    addMessages: v.string(),
  },
  returns: vResponseResult,
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.subject !== args.subject) throw new ConvexError({ code: "FORBIDDEN" });
    const receipt = await responseReceipt(
      ctx,
      "respond",
      row.threadId,
      args.approvalId,
      JSON.stringify([args.approved, args.reason ?? null]),
    );
    if (receipt.messageId !== undefined) return { messageId: receipt.messageId, replayed: true };
    const approvals = row.approvals;
    const key = await approvalKey(args.approvalId);
    const index =
      approvals?.requests.findIndex((request) => !request.deferred && request.key === key) ?? -1;
    const decision = approvals?.requests[index];
    if (
      !row.approvalBlocked ||
      row.cancelled ||
      !approvals ||
      approvals.cleanupPending ||
      !decision
    )
      throw new ConvexError({ code: "APPROVAL_NOT_FOUND" });
    if (approvals.resolved.includes(index))
      throw new ConvexError({ code: "APPROVAL_ALREADY_RESOLVED" });
    const messageId = await saveResponses(
      ctx,
      { ...row, messageId: decision.messageId, addMessages: args.addMessages },
      [
        {
          approvalId: args.approvalId,
          approved: args.approved,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(decision.providerExecuted ? { providerExecuted: true as const } : {}),
        },
      ],
    );
    await saveResponseReceipt(ctx, receipt, messageId);
    const resolved = [...approvals.resolved, index];
    await ctx.db.patch("assignments", row._id, {
      approvals: {
        ...approvals,
        resolved,
        requests: approvals.requests.map((request, offset) =>
          offset === index
            ? { ...request, state: args.approved ? ("approved" as const) : ("denied" as const) }
            : request,
        ),
      },
    });
    if (resolved.length === approvals.requests.length) {
      await ctx.db.patch("inbox", approvals.inboxId, { messageId });
      await ctx.db.patch("assignments", row._id, { approvalBlocked: false });
      await wake(ctx, { ...row, approvalBlocked: false });
    }
    return { messageId, replayed: false };
  },
});

/** Save a deferred native result and release its continuation atomically.
 * One exact <=1 MiB call + native prompt <=1 MiB + six <=1 MiB merge
 * heads (Agent messages.ts:436-477) + <=64 KiB saved result + <4.75 MiB
 * bounded indexed readiness/group-release/wake metadata (releaseGroups):
 * <13 MiB <16 MiB. Approval/deferred counts never multiply native reads.
 * At most 16 fixed-size references are reindexed per answer.
 * No tool payload is copied into coordination state, even for large inputs.
 */
export const answer = mutation({
  args: {
    assignmentId: v.id("assignments"),
    subject: v.string(),
    toolCallId: v.string(),
    text: v.string(),
  },
  returns: vResponseResult,
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row || row.subject !== args.subject) throw new ConvexError({ code: "FORBIDDEN" });
    if (!args.text.trim() || args.text.length > LIMITS.messageLength)
      throw new ConvexError({ code: "INVALID_MESSAGE" });
    if (!args.toolCallId || args.toolCallId.length > LIMITS.nativeCallIdLength)
      throw new ConvexError({ code: "TOOL_CALL_NOT_FOUND" });
    const receipt = await responseReceipt(ctx, "answer", row.threadId, args.toolCallId, args.text);
    if (receipt.messageId !== undefined) return { messageId: receipt.messageId, replayed: true };
    const pause = row.approvals;
    const key = await approvalKey(args.toolCallId);
    const index =
      pause?.requests.findIndex((request) => request.deferred && request.key === key) ?? -1;
    const request = pause?.requests[index];
    if (
      !pause ||
      !request ||
      !row.approvalBlocked ||
      row.cancelled ||
      pause.cleanupPending ||
      pause.epoch !== row.cancellationEpoch
    )
      throw new ConvexError({ code: "TOOL_CALL_NOT_FOUND" });
    const [message]: (MessageDoc | null)[] = await ctx.runQuery(
      pause.getMessages as FunctionHandle<"query">,
      { messageIds: [request.messageId] },
    );
    const content = message?.message?.content;
    const call =
      message?.threadId === row.threadId &&
      message.message?.role === "assistant" &&
      Array.isArray(content)
        ? content.find((part) => part.type === "tool-call" && part.toolCallId === args.toolCallId)
        : undefined;
    if (!call || call.type !== "tool-call" || call.providerExecuted)
      throw new ConvexError({ code: "TOOL_CALL_NOT_FOUND" });
    // Agent 0.7.7 example/convex/chat/human.ts:135-148 uses exactly this
    // native tool-result. Our mutation also releases the existing inbox anchor.
    // Reuse that control slot: a child with a full ready-FIFO backlog must
    // still be answerable, and partial answers must never allocate more rows.
    const saved = (await ctx.runMutation(pause.addMessages as FunctionHandle<"mutation">, {
      threadId: row.threadId,
      agentName: row.agent,
      promptMessageId: request.messageId,
      failPendingSteps: false,
      messages: [
        {
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: args.toolCallId,
                toolName: call.toolName,
                output: { type: "text", value: args.text },
              },
            ],
          },
        },
      ],
    })) as { messages: MessageDoc[] };
    const messageId = saved.messages[0]._id;
    await saveResponseReceipt(ctx, receipt, messageId);
    const remaining = pause.requests
      .map((request, offset) => ({ request, resolved: pause.resolved.includes(offset) }))
      .filter((_, offset) => offset !== index);
    const approvals = remaining.length
      ? {
          ...pause,
          requests: remaining.map((entry) => entry.request),
          resolved: remaining.flatMap((entry, offset) => (entry.resolved ? [offset] : [])),
        }
      : undefined;
    const blocked = remaining.some((entry) => !entry.resolved);
    await ctx.db.patch("assignments", row._id, { approvals, approvalBlocked: blocked });
    // Always retain the last saved result as the future prompt, including a
    // partial answer. A concurrent answer/respond serializes on this same row.
    await ctx.db.patch("inbox", pause.inboxId, { messageId });
    if (!blocked) await wake(ctx, { ...row, approvals, approvalBlocked: false });
    return { messageId, replayed: false };
  },
});

export const continueTurn = mutation({
  args: {
    assignmentId: v.id("assignments"),
    executionId: v.string(),
    cancellationEpoch: v.number(),
    messageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (
      row &&
      !row.cancelled &&
      row.turnToken === args.executionId &&
      row.cancellationEpoch === args.cancellationEpoch &&
      row.turnStatus === "running"
    ) {
      await disarmSlice(ctx, row);
      await sealGroups(ctx, row);
      // Keep the claimed ready-work prompt as the generation boundary across
      // slices. Native Agent includes the whole response order, including
      // tool results, notes and continuation prompts in stepOrder chronology.
      await ctx.db.patch("assignments", row._id, {
        continueSlice: true,
      });
      // Release sealed results inside this existing step; v1's positional
      // Workflow sequence remains untouched. A running slice cannot be claimed
      // again by wake, so its normal between-slice continuation still owns it.
      await wake(ctx, { ...row, continueSlice: true });
    }
    return null;
  },
});

/** Phase 1c's seam: all between-slice state checks belong in this mutation. */
export const betweenSlices = internalMutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (
      !row ||
      row.cancelled ||
      row.turnToken !== args.executionId ||
      row.turnStatus !== "running" ||
      !row.continueSlice
    )
      return null;
    await disarmSlice(ctx, row);
    const run = row.runId ? await ctx.db.get("runs", row.runId) : null;
    if (!run || run.cancelled) return null;
    // Exhausting delegation budget never prevents a final answer. Admission of
    // additional effects checks launches/hops transactionally in reserve.
    if (
      run.launches > (row.limits ?? LIMITS).runLaunches ||
      run.hops > (row.limits ?? LIMITS).runHops
    )
      throw new Error("RUN_BUDGET");
    return args.executionId;
  },
});

export const sliceLimit = internalMutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(api.queue.finish, {
      assignmentId: args.assignmentId,
      turnToken: args.executionId,
      errorCode: "SLICE_LIMIT",
    });
    return null;
  },
});
export const failWorkflow = internalMutation({
  args: { assignmentId: v.id("assignments"), executionId: v.string() },
  returns: v.null(),
  handler: (ctx, args) => markAmbiguous(ctx, args.assignmentId, args.executionId),
});

/** Cancel sets fences before canceling Workflow, which cannot abort actions. */
export const cancel = mutation({
  args: { assignmentId: v.id("assignments"), subject: v.string() },
  returns: v.array(v.object({ threadId: v.string(), agent: v.string() })),
  handler: async (ctx, args) => {
    const root = await ctx.db.get("assignments", args.assignmentId);
    if (!root || root.subject !== args.subject || root.childRunId) throw new Error("FORBIDDEN");
    const children = (
      await Promise.all(
        (["queued", "running", "asking"] as const).map((status) =>
          ctx.db
            .query("subagentRuns")
            .withIndex("by_root_status", (q) =>
              q.eq("rootAssignmentId", root._id).eq("status", status),
            )
            .take((root.limits ?? LIMITS).activeChildrenPerRoot),
        ),
      )
    ).flat();
    const affected = [
      root,
      ...(
        await Promise.all(
          children.map((run) =>
            run.childAssignmentId ? ctx.db.get("assignments", run.childAssignmentId) : null,
          ),
        )
      ).filter((row): row is Doc<"assignments"> => row !== null),
    ];
    for (const row of affected) {
      await disarmSlice(ctx, row);
      await disarmRecovery(ctx, row);
      const approvalCleanup = !!row.approvals?.requests.length;
      await ctx.db.patch("assignments", row._id, {
        cancelled: true,
        cancellationEpoch: row.cancellationEpoch + 1,
        turnStatus: "idle",
        errorCode: null,
        turnToken: undefined,
        promptMessageId: undefined,
        inboxId: undefined,
        workflowId: undefined,
        loopWaiting: false,
        pinged: false,
        queuedMessages: 0,
        notesPending: 0,
        logicalPromptMessageId: undefined,
        continueSlice: false,
        hookContinue: false,
        approvalBlocked: !!approvalCleanup,
        approvals: approvalCleanup ? { ...row.approvals!, cleanupPending: true } : undefined,
      });
      // Only ready rows are read here. Raw passive bodies are cleared by one
      // bounded job per assignment, preserving the 12,680 KiB cancel ceiling.
      const inbox = await ctx.db
        .query("inbox")
        .withIndex("by_assignment_ready", (q) =>
          q.eq("assignmentId", row._id).eq("passive", undefined),
        )
        .take((row.limits ?? LIMITS).queueLength + 2);
      // A staged hook continuation is addressed directly, never included in a
      // backlog scan. <=16 assignments * (64 KiB text +1 KiB metadata) read
      // for deletion adds <=1,040 KiB to the 12,680 KiB cancel budget: <14 MiB.
      if (row.hookContinue && row.inboxId) await ctx.db.delete("inbox", row.inboxId);
      if (row.notesPending)
        await ctx.scheduler.runAfter(0, internal.hooks.cancelNotes, {
          assignmentId: row._id,
          epoch: row.cancellationEpoch,
        });
      if (row.pendingGeneration || approvalCleanup)
        await ctx.scheduler.runAfter(0, internal.cancellation.cleanup, {
          assignmentId: row._id,
          pending: row.pendingGeneration,
          approvalEpoch: approvalCleanup ? row.approvals!.epoch : undefined,
        });
      for (const item of inbox) {
        await ctx.db.patch("runs", item.runId, { cancelled: true });
        await ctx.db.delete("inbox", item._id);
      }
      if (row.runId) await ctx.db.patch("runs", row.runId, { cancelled: true });
      if (row.workflowId)
        await (row.childRunId ? childLane : rootLane).cancel(ctx, row.workflowId as WorkflowId);
    }
    for (const run of children) {
      await ctx.db.patch("subagentRuns", run._id, {
        status: "failed",
        deliveryStatus: "blocked",
        errorCode: "ROOT_UNAVAILABLE",
        finishedAt: Date.now(),
        deliveryAt: Date.now(),
        events: [
          ...run.events,
          { phase: "failed" as const, at: Date.now(), errorCode: "ROOT_UNAVAILABLE" as const },
        ].slice(-LIMITS.runEvents),
      });
    }
    await ctx.db.patch("assignments", root._id, {
      activeRuns: 0,
      historyRuns: (root.historyRuns ?? 0) + children.length,
    });
    return affected.map((row) => ({ threadId: row.threadId, agent: row.agent }));
  },
});

/**
 * Recovery lives outside the positional Workflow journal. A missing awaited
 * event can mean next's completion callback is still in flight, not that the
 * work was consumed. Keep checking through that transition with capped backoff.
 * Only Workflow's actual awaited ping permits a re-ring and a pinged reset;
 * this avoids another event/generation when resume is already in flight.
 */
export const reconcile = internalMutation({
  args: { assignmentId: v.id("assignments"), recoveryAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { assignmentId, recoveryAt }) => {
    const row = await ctx.db.get("assignments", assignmentId);
    if (!row || (recoveryAt !== undefined && row.recoveryAt !== recoveryAt)) return null;
    if (!(await needsRecovery(ctx, row))) {
      await disarmRecovery(ctx, row);
      return null;
    }
    // Retire this check before arming its successor in this same transaction.
    // A stale scheduled invocation must not clear a newer check's marker.
    if (row.recoveryJobId) {
      const job = await ctx.db.system.get(row.recoveryJobId);
      if (job?.state.kind === "pending") await ctx.scheduler.cancel(row.recoveryJobId);
    }
    await ctx.db.patch("assignments", row._id, {
      recoveryAt: undefined,
      recoveryJobId: undefined,
    });
    const status = row.workflowId
      ? await laneManager(!!row.childRunId, row.limits ?? LIMITS).status(
          ctx,
          row.workflowId as WorkflowId,
        )
      : null;
    if (
      status?.type === "inProgress" &&
      status.running.some((step) => step.kind === "event" && step.name === "ping")
    ) {
      await ctx.db.patch("assignments", row._id, { pinged: false });
      await wake(ctx, { ...row, loopWaiting: true, pinged: false, recoveryAt: undefined });
    } else {
      await armRecovery(
        ctx,
        { ...row, recoveryAt: undefined },
        Math.min(
          (row.recoveryDelayMs ?? LIMITS.reconcileIntervalMs) * 2,
          LIMITS.reconcileMaxIntervalMs,
        ),
      );
    }
    return null;
  },
});
