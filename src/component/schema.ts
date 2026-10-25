import { defineSchema, defineTable } from "convex/server";
import { v, type Validator } from "convex/values";

import { modelOverrides } from "./models.js";

import { limitsValidator } from "./limits.js";

export const turnOrigin = v.union(v.literal("user"), v.literal("subagent_result"));
export const turnStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("idle"),
  v.literal("recovery_required"),
);
export const errorCode = v.union(
  v.null(),
  v.literal("BUDGET_EXCEEDED"),
  v.literal("HOOK_FAILED"),
  v.literal("GENERATION_FAILED"),
  v.literal("SLICE_LIMIT"),
  v.literal("APPROVAL_LIMIT"),
  v.literal("CLEANUP_FAILED"),
  v.literal("AUTHORIZATION_DENIED"),
  v.literal("EXECUTION_AMBIGUOUS"),
);
// A run reports every turn failure code, plus the four outcomes that only a
// delegated run can have. Deriving from errorCode keeps one source of truth, so
// a new turn failure code can never be missing from run reports.
const [, ...turnFailureCodes] = errorCode.members;
export const runErrorCode = v.union(
  v.null(),
  ...turnFailureCodes,
  v.literal("EMPTY_RESULT"),
  v.literal("RESULT_UNVERIFIED"),
  v.literal("ROOT_UNAVAILABLE"),
  v.literal("DELIVERY_FAILED"),
);
export const denialCode = v.union(
  v.literal("HOOK_BLOCKED"),
  v.literal("ACTIVE_LIMIT"),
  v.literal("TASK_LIMIT"),
  v.literal("FORBIDDEN"),
  v.literal("STALE_TURN"),
  v.literal("DELEGATION_CONFLICT"),
  v.literal("RUN_BUDGET"),
  v.literal("DEPTH_LIMIT"),
  v.literal("GROUP_LIMIT"),
  v.literal("GROUP_CLOSED"),
  v.literal("GROUP_CONFLICT"),
  v.literal("CHILD_FINISHED"),
  v.literal("MESSAGE_LIMIT"),
  v.literal("ASK_PENDING"),
  v.literal("ASK_WITH_CHILDREN"),
  v.literal("QUEUE_LIMIT"),
);
export const runStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("asking"),
  v.literal("completed"),
  v.literal("failed"),
);
export const deliveryStatus = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("failed"),
  v.literal("blocked"),
);
export const runPhase = v.union(
  v.literal("queued"),
  v.literal("started"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("result_accepted"),
  v.literal("delivery_failed"),
  v.literal("delivery_blocked"),
);
export const runEvent = v.object({
  phase: runPhase,
  at: v.number(),
  errorCode: runErrorCode,
});
const receiptIdentity = {
  assignmentId: v.string(),
  threadId: v.string(),
  receiptId: v.string(),
};
export const receipt = v.union(
  v.object({ ...receiptIdentity, status: v.literal("accepted"), position: v.number() }),
  v.object({ ...receiptIdentity, status: v.literal("duplicate"), position: v.number() }),
  v.object({
    status: v.literal("rejected"),
    code: v.union(
      v.literal("KEY_CONFLICT"),
      v.literal("QUEUE_FULL"),
      v.literal("CANCELLED"),
      v.literal("INVALID_MESSAGE"),
      v.literal("INVALID_REQUEST_KEY"),
      v.literal("UNKNOWN_AGENT"),
      v.literal("INVALID_MODELS"),
      v.literal("ATTACHMENT_LIMIT"),
      v.literal("RECOVERY_REQUIRED"),
    ),
  }),
);
export const subagentCounts = v.object({
  active: v.number(),
  history: v.number(),
  total: v.number(),
});
export const activity = v.object({
  assignmentId: v.string(),
  threadId: v.string(),
  agent: v.string(),
  assignmentStatus: v.literal("open"),
  turnStatus,
  queuedMessages: v.number(),
  errorCode,
  /** The thread's current (or last) user run: the same `runId` slot facts and
   * budget checks receive, so a host can key a recovery step to the exact
   * stopped run. Absent before the first request is admitted. */
  runId: v.optional(v.string()),
  subagents: subagentCounts,
});
export const scope = v.object({
  assignmentId: v.string(),
  threadId: v.string(),
  subject: v.string(),
  agent: v.string(),
});
export const subagentRun = v.object({
  runId: v.string(),
  side: v.boolean(),
  childThreadId: v.union(v.string(), v.null()),
  agent: v.string(),
  status: runStatus,
  deliveryStatus,
  createdAt: v.number(),
  startedAt: v.union(v.null(), v.number()),
  finishedAt: v.union(v.null(), v.number()),
  deliveryAt: v.union(v.null(), v.number()),
  resultMessageId: v.union(v.null(), v.string()),
  errorCode: runErrorCode,
  events: v.array(v.object({ ...runEvent.fields, runId: v.string(), agent: v.string() })),
});

export const vPaginationResult = <T extends Validator<unknown, "required", string>>(item: T) =>
  v.object({
    page: v.array(item),
    continueCursor: v.string(),
    isDone: v.boolean(),
  });

export const pendingGeneration = v.object({
  messageId: v.string(),
  executionId: v.string(),
  epoch: v.number(),
  getMessages: v.string(),
  finalizeMessage: v.string(),
  stream: v.optional(v.object({ id: v.string(), abort: v.string() })),
});

export default defineSchema({
  // Execution identity and epoch fence every managed write. The native thread
  // owns messages; this row holds only references and coordination facts.
  assignments: defineTable({
    // Fixed-size references only: the native component continues to own bodies.
    // Exact step identity captured with the native save, consumed by usage
    // recording. Scalar reference only, never a copy of model output.
    modelStep: v.optional(v.object({ messageId: v.string(), stepOrder: v.number() })),
    contextMessages: v.optional(
      v.array(
        v.object({
          id: v.string(),
          order: v.number(),
          stepOrder: v.number(),
          bytes: v.number(),
          sequence: v.number(),
        }),
      ),
    ),
    reviewed: v.optional(
      v.array(
        v.object({
          agent: v.string(),
          turn: v.number(),
          at: v.number(),
          boundary: v.number(),
        }),
      ),
    ),
    // Read by claim (hook `turn`), hookState and reviewContext; 0 until a turn completes.
    completedTurns: v.number(),
    // Read by note admission/claim/cancel; never charged to ready work.
    notesPending: v.number(),
    // Read by beforeTurn: a continuation has its own prompt, while generation
    // remains bounded by the original ready-work anchor below.
    logicalPromptMessageId: v.optional(v.string()),
    // Only the first slice owns the shared routing bit; terminal fences settle it.
    routingAgentIndex: v.optional(v.number()),
    // Read by claim, cancel and deferChildFailure: an afterTurn continuation is
    // staged at inboxId and must be removed if the turn ends without claiming it.
    hookContinue: v.optional(v.boolean()),
    subject: v.string(),
    agent: v.string(),
    threadId: v.string(),
    // Latest accepted thread policy; read only when creating the next run.
    models: v.optional(modelOverrides),
    runTurn: v.string(),
    workflowId: v.optional(v.string()),
    // The registration's fully resolved host limits, copied from the root at
    // creation. Read by every bounded query/take on this row.
    limits: limitsValidator,
    // Read by wake: a ping is only sent to a loop that is awaiting one. No index.
    loopWaiting: v.optional(v.boolean()),
    pinged: v.optional(v.boolean()),
    recoveryAt: v.optional(v.number()),
    recoveryJobId: v.optional(v.id("_scheduled_functions")),
    recoveryDelayMs: v.optional(v.number()),
    watchdogId: v.optional(v.id("_scheduled_functions")),
    activeSlice: v.optional(v.string()),
    pendingGeneration: v.optional(pendingGeneration),
    cancellationEpoch: v.number(),
    cancelled: v.boolean(),
    runId: v.optional(v.id("runs")),
    childRunId: v.optional(v.string()),
    rootAssignmentId: v.optional(v.id("assignments")),
    turnStatus,
    errorCode,
    queuedMessages: v.number(),
    nextSequence: v.number(),
    nextTurn: v.number(),
    turnToken: v.optional(v.string()),
    promptMessageId: v.optional(v.string()),
    // Set by wake with the reserved head; read by claim and write.
    turnOrigin: v.optional(turnOrigin),
    inboxId: v.optional(v.id("inbox")),
    approvalBlocked: v.optional(v.boolean()),
    // At most LIMITS.approvalsPerPause fixed-size approval keys, never payloads.
    approvals: v.optional(
      v.object({
        inboxId: v.id("inbox"),
        epoch: v.number(),
        getMessages: v.string(),
        addMessages: v.string(),
        cleanupPending: v.optional(v.boolean()),
        requests: v.array(
          v.object({
            // Deferred calls share the same bounded exact-id pause/cleanup path.
            // Read by answer/respond/cancel to choose the native result protocol.
            deferred: v.optional(v.boolean()),
            key: v.string(),
            messageId: v.string(),
            providerExecuted: v.boolean(),
            // Exact native ids remain in messageId's document. Hashes keep even
            // near-1 MiB call ids out of coordination rows. Read by write() to
            // retire the request once its native tool result is saved.
            toolCallKey: v.bytes(),
            state: v.optional(
              v.union(
                v.literal("pending"),
                v.literal("approved"),
                v.literal("denied"),
                v.literal("running"),
              ),
            ),
          }),
        ),
        resolved: v.array(v.number()),
      }),
    ),
    continueSlice: v.optional(v.boolean()),
    lastSlice: v.optional(v.string()),
    // Roots only (0 elsewhere). activeRuns is the live (queued, running or
    // asking) run count, read by reserve admission, delegateContext and activity.
    // nextRunSequence is the count of runs ever reserved, read by reserve (the
    // next delegation sequence) and activity. Every settle or cancel moves one run
    // from active to history, so history is nextRunSequence - activeRuns.
    activeRuns: v.number(),
    nextRunSequence: v.number(),
  }).index("by_thread", ["threadId"]),
  inbox: defineTable({
    assignmentId: v.id("assignments"),
    messageId: v.string(),
    sequence: v.number(),
    // Deferred joins append later than their native save. Claim compares this
    // recorded save order, never queue insertion order, to retain newer answers.
    passive: v.optional(v.boolean()),
    // All posted notes retain text until claim; delivered controls retain ids.
    noteText: v.optional(v.string()),
    // Hook continuations wait for claim so notes precede their native prompt.
    continueText: v.optional(v.string()),
    // Separates cancelled payloads from fresh admission before cleanup runs.
    noteEpoch: v.optional(v.number()),
    from: v.optional(v.string()),
    messageSequence: v.optional(v.number()),
    // A joined group generates from its newest result, but notes precede its
    // earliest native member. Set only on group releases; read by claim.
    earliestMessageId: v.optional(v.string()),
    earliestMessageSequence: v.optional(v.number()),
    runId: v.id("runs"),
    // Read by wake (result/note make a subagent_result turn; user/parent make a
    // user turn), claim (non-user kinds merge consecutively; a user row ends it) and hooks.origins
    // (note and continue label their message, result falls through to its run).
    kind: v.union(
      v.literal("user"),
      v.literal("result"),
      v.literal("parent"),
      v.literal("note"),
      v.literal("continue"),
    ),
  })
    .index("by_message", ["messageId"])
    .index("by_assignment_ready", ["assignmentId", "passive", "noteEpoch", "sequence"]),
  // A run outlives an individual turn: results and subsequent delegations spend
  // the same launch/hop budget. Results are ready independently of siblings.
  runs: defineTable({
    // Run snapshot shared by every root/descendant/result turn. A beforeTurn
    // hook may choose its agent model at run start; later turns only read it.
    // Read at claim, never replaced by a subsequent send's thread policy.
    models: v.optional(modelOverrides),
    // Bit sets over agent indexes: startedAgents marks agents that began in this
    // run (claim isRunStart); routingAgents marks the owner of a pending
    // beforeTurn model decision (hooks.routing/settleRouting).
    startedAgents: v.int64(),
    routingAgents: v.int64(),
    // Read by continueAdmission against limits.continuesPerRun.
    continues: v.number(),
    // Read by reserve against limits.sideRunsPerRun.
    sideRuns: v.number(),
    launches: v.number(),
    hops: v.number(),
    cancelled: v.boolean(),
  }),
  // Both are durable facts, with separate indexed lifecycles. Effect receipts
  // expire; attachment attestations are excluded from effect cleanup.
  // The union avoids dummy lease/result fields on ownership records and adds
  // no table. Native Agent still owns file bytes, metadata and refcounts.
  receipts: defineTable(
    v.union(
      v.object({
        kind: v.literal("effect"),
        scope: v.string(),
        key: v.string(),
        fingerprint: v.string(),
        status: v.union(
          v.literal("running"),
          v.literal("done"),
          v.literal("failed"),
          v.literal("unknown"),
        ),
        // Present only while status is "running": the action's fencing token and
        // lease horizon, read by ledger begin/complete/unknown. Every transition
        // out of running clears both, so done/failed/unknown rows carry neither.
        claim: v.optional(v.string()),
        leaseUntil: v.optional(v.number()),
        // Read by ledger begin on replay and by request/response receipt lookups.
        result: v.optional(v.any()),
        expiresAt: v.number(),
      }),
      v.object({
        kind: v.literal("attachment"),
        native: v.string(),
        fileId: v.string(),
        subject: v.string(),
        // Absent: trusted upload grant. Present: exact native attachment saved
        // atomically with that message, read by extraction admission and policy.
        threadId: v.optional(v.string()),
        messageId: v.optional(v.string()),
      }),
    ),
  )
    .index("by_scope_key", ["scope", "key"])
    .index("by_expiry", ["kind", "expiresAt"])
    .index("by_file", ["native", "fileId", "subject", "threadId"])
    .index("by_message", ["native", "messageId"]),
  subagentRuns: defineTable({
    side: v.optional(v.boolean()),
    runId: v.string(),
    rootCancellationEpoch: v.number(),
    parentRunId: v.id("runs"),
    dedupKey: v.string(),
    payloadFingerprint: v.string(),
    rootAssignmentId: v.id("assignments"),
    actorAssignmentId: v.id("assignments"),
    // Read by reserve (depth bound, child depth) and the tree projection.
    depth: v.number(),
    group: v.optional(v.string()),
    wait: v.optional(v.union(v.literal("each"), v.literal("all"))),
    groupReleased: v.optional(v.boolean()),
    // Only a sealed, fully delivered cohort enters the ready-group index.
    // Read by releaseGroups; historical incomplete cohorts cannot hide it.
    groupReady: v.optional(v.boolean()),
    // The launching slice seals its cohorts before results may release them.
    // Read by admission (closed membership), release, and the indexed seal.
    groupSealed: v.optional(v.boolean()),
    // The exact native question id is recorded with its native save and read
    // for verification before delivery. `asking` itself is the open-question fence.
    questionMessageId: v.optional(v.string()),
    // Read by interaction admission against limits.messagesPerChild.
    messagesReceived: v.number(),
    childAssignmentId: v.optional(v.id("assignments")),
    childThreadId: v.optional(v.string()),
    // Recorded with native final saves, cleared on every new turn claim, and
    // read by settlement verification: only the last turn may supply a result.
    childResultMessageId: v.optional(v.string()),
    // Host-verified outcome of the last ended turn, retained while descendants
    // or inbox work fence settlement. Claim clears it before the next turn.
    // Read by idle settlement; no native transcript is scanned or copied.
    lastTurnResult: v.optional(
      v.object({
        messageId: v.optional(v.string()),
        errorCode: runErrorCode,
      }),
    ),
    agent: v.string(),
    actorAgent: v.string(),
    status: runStatus,
    deliveryStatus,
    errorCode: runErrorCode,
    deliveryToken: v.string(),
    coordinateHandle: v.string(),
    createdAt: v.number(),
    sequence: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    deliveryAt: v.optional(v.number()),
    resultMessageId: v.optional(v.string()),
    // Native notifications can share a millisecond; this parent-local order
    // selects the latest exact anchor when the closed group is released.
    resultSequence: v.optional(v.number()),
    events: v.array(runEvent),
  })
    .index("by_result_message", ["resultMessageId"])
    .index("by_dedup", ["dedupKey"])
    .index("by_run", ["runId"])
    .index("by_root_sequence", ["rootAssignmentId", "sequence"])
    .index("by_root_status", ["rootAssignmentId", "status"])
    .index("by_parent_delivery", ["actorAssignmentId", "side", "deliveryStatus"])
    .index("by_ready_group", [
      "actorAssignmentId",
      "rootCancellationEpoch",
      "groupReady",
      "groupReleased",
      "parentRunId",
    ])
    .index("by_membership", ["actorAssignmentId", "parentRunId", "groupSealed"])
    .index("by_group", ["actorAssignmentId", "parentRunId", "group"])
    .index("by_unjoined", ["actorAssignmentId", "rootCancellationEpoch", "wait", "groupReleased"])
    .index("by_root_run", ["rootAssignmentId", "parentRunId", "sequence"]),
});
