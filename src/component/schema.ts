import { defineSchema, defineTable } from "convex/server";
import { v, type Validator } from "convex/values";

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
  v.literal("GENERATION_FAILED"),
  v.literal("SLICE_LIMIT"),
  v.literal("APPROVAL_LIMIT"),
  v.literal("CLEANUP_FAILED"),
  v.literal("AUTHORIZATION_DENIED"),
  v.literal("EXECUTION_AMBIGUOUS"),
);
export const runErrorCode = v.union(
  v.null(),
  v.literal("GENERATION_FAILED"),
  v.literal("SLICE_LIMIT"),
  v.literal("APPROVAL_LIMIT"),
  v.literal("CLEANUP_FAILED"),
  v.literal("EXECUTION_AMBIGUOUS"),
  v.literal("EMPTY_RESULT"),
  v.literal("RESULT_UNVERIFIED"),
  v.literal("AUTHORIZATION_DENIED"),
  v.literal("ROOT_UNAVAILABLE"),
  v.literal("DELIVERY_FAILED"),
);
export const denialCode = v.union(
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
export const receipt = v.object({
  assignmentId: v.string(),
  threadId: v.string(),
  receiptId: v.string(),
  status: v.literal("accepted"),
});
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
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null()),
    ),
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
    subject: v.string(),
    agent: v.string(),
    threadId: v.string(),
    runTurn: v.string(),
    workflowId: v.optional(v.string()),
    limits: v.optional(limitsValidator),
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
            key: v.string(),
            messageId: v.string(),
            providerExecuted: v.boolean(),
            // Exact native ids remain in messageId's document. Hashes keep even
            // near-1 MiB call ids out of coordination rows. Optional for v1 rows.
            toolCallKey: v.optional(v.bytes()),
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
    activeRuns: v.optional(v.number()),
    historyRuns: v.optional(v.number()),
    nextRunSequence: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_loop_waiting", ["loopWaiting", "turnStatus"]),
  inbox: defineTable({
    assignmentId: v.id("assignments"),
    messageId: v.string(),
    sequence: v.number(),
    // Deferred joins append later than their native save. Claim compares this
    // recorded save order, never queue insertion order, to retain newer answers.
    messageSequence: v.optional(v.number()),
    runId: v.id("runs"),
    kind: v.union(
      v.literal("user"),
      v.literal("result"),
      v.literal("steer"),
      v.literal("parent"),
      v.literal("note"),
    ),
  }).index("by_assignment_sequence", ["assignmentId", "sequence"]),
  // A run outlives an individual turn: results and subsequent delegations spend
  // the same launch/hop budget. Results are ready independently of siblings.
  runs: defineTable({
    launches: v.number(),
    hops: v.number(),
    cancelled: v.boolean(),
  }),
  receipts: defineTable({
    scope: v.string(),
    key: v.string(),
    fingerprint: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("unknown"),
    ),
    claim: v.string(),
    leaseUntil: v.number(),
    result: v.optional(v.any()),
    expiresAt: v.number(),
  })
    .index("by_scope_key", ["scope", "key"])
    .index("by_expiry", ["expiresAt"]),
  subagentRuns: defineTable({
    runId: v.string(),
    rootCancellationEpoch: v.number(),
    parentRunId: v.id("runs"),
    dedupKey: v.string(),
    payloadFingerprint: v.string(),
    rootAssignmentId: v.id("assignments"),
    actorAssignmentId: v.id("assignments"),
    // Optional only for replaying existing depth-one runs. Read by admission,
    // group release and the tree projection; never duplicate native messages.
    depth: v.optional(v.number()),
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
    messagesReceived: v.optional(v.number()),
    childAssignmentId: v.optional(v.id("assignments")),
    childThreadId: v.optional(v.string()),
    // Recorded with native final saves, cleared on every new turn claim, and
    // read by settlement verification: only the last turn may supply a result.
    childResultMessageId: v.optional(v.string()),
    agent: v.string(),
    rootAgent: v.string(),
    actorAgent: v.string(),
    subject: v.string(),
    status: runStatus,
    deliveryStatus,
    errorCode: runErrorCode,
    deliveryToken: v.string(),
    coordinateHandle: v.string(),
    runTurn: v.string(),
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
    .index("by_dedup", ["dedupKey"])
    .index("by_run", ["runId"])
    .index("by_root_sequence", ["rootAssignmentId", "sequence"])
    .index("by_root_status", ["rootAssignmentId", "status"])
    .index("by_parent_delivery", ["actorAssignmentId", "deliveryStatus"])
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
