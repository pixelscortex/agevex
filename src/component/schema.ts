/**
 * The agevex tables and the shared validators of the public API.
 *
 * Tables: `assignments` (one managed thread: execution token, epoch, queue
 * counters, approval pause, recovery), `inbox` (ready work, passive notes and
 * control ids), `runs` (one accepted request's shared budget), `receipts`
 * (idempotency ledger, compact proposals and attachment attestations) and `subagentRuns` (one
 * delegation). Every field comment names its readers. The validators above
 * the schema (`receipt`, `activity`, `subagentRun`, error/denial codes, ...)
 * are shared with the client, which imports them from this file.
 */
import { defineSchema, defineTable } from "convex/server";
import { v, type Validator } from "convex/values";

import { settingsSnapshot } from "./run_settings.js";
import { modelOverrides } from "./models.js";

import { limitsValidator } from "./limits.js";
import { textConfig, textJob, textBoundary, storedSummary } from "./text/values.js";
import { storedProposal } from "./turns/decision_proposals.js";

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
  v.literal("RUN_TIMEOUT"),
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
  v.literal("MESSAGE_TOO_LARGE"),
  v.literal("MESSAGE_EMPTY"),
  v.literal("SIDE_RUN"),
  v.literal("MESSAGE_RATE_LIMIT"),
  v.literal("KEY_CONFLICT"),
  v.literal("NO_PARENT"),
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
    // Last-started active local calls, in start order. Tool wrappers remove only
    // their own marker; disarm/cancel clear the whole bounded slice inventory.
    activeTools: v.optional(v.array(v.object({ key: v.string(), name: v.string() }))),
    // Background worker dispatch and cadence; root-only, read by text/jobs.
    textConfig: v.optional(textConfig),
    // Native thread owns the title body. Version/source fence generated commits.
    titleVersion: v.optional(v.number()),
    titleSource: v.optional(v.union(v.literal("auto"), v.literal("user"))),
    titleTask: v.optional(textJob),
    summaryTask: v.optional(textJob),
    // Only a successfully completed root turn advances the safe input boundary.
    textCompleted: v.optional(textBoundary),
    // Read by summary endpoint and the next incremental display summary.
    textSummary: v.optional(storedSummary),
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
    // Set by claim with each slice, cleared only by disarmSlice. Present on a
    // running turn = a slice is in flight; absent on a running turn = between
    // slices (continueTurn disarmed it). Read by claim (next-slice admission),
    // betweenSlices, stalled (with lastSlice, the active slice) and disarmSlice.
    // Model steps claimed in the current logical turn, reset on its first slice.
    modelSteps: v.optional(v.number()),
    watchdogId: v.optional(v.id("_scheduled_functions")),
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
    // The turn's prompt: set by wake to the reserved head, moved by claim to
    // the newest merged result and by a hook continuation to its saved prompt.
    // Claim returns it; the host reads it for beforeTurn and anchors native
    // generation context on it.
    promptMessageId: v.optional(v.string()),
    // Reporting identity survives approval anchors; claim resets it for new
    // work/afterTurn prompts, write appends saves, completion reads exact ids.
    turnReport: v.optional(
      v.object({
        promptMessageId: v.string(),
        messageIds: v.array(v.string()),
        maxMessages: v.number(),
        resumeInboxId: v.optional(v.id("inbox")),
      }),
    ),
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
            // Pending/detail read this <=32 KiB proposal instead of native reasoning.
            // Retire/answer/cancel delete it with the exact reference; no TTL race.
            proposalId: v.id("receipts"),
            providerExecuted: v.boolean(),
            // Exact native ids remain in messageId's document. Hashes keep even
            // near-1 MiB call ids out of coordination rows. Read by write() to
            // retire the request once its native tool result is saved.
            toolCallKey: v.bytes(),
            // Set by respond with the native decision; deferred calls never set it
            // (answer removes them). Read by respond (duplicate decision, last
            // decision unblocks), answer (remaining undecided), awaitingApprovalResults,
            // cleanup (cancel repeats no decision) and write() (a resolved
            // provider-executed call is consumed by the next assistant response:
            // a turn only runs once every recorded request is resolved).
            resolved: v.optional(v.literal(true)),
            // The approved input is stored on the proposal (deleted with this request),
            // so it cannot expire while the pause is open; fail closed if it is missing.
            effective: v.optional(v.boolean()),
          }),
        ),
      }),
    ),
    // The slice id the last claim accepted (absent for a first slice keyed by
    // its turn token). Read by claim (a replayed slice id is refused) and
    // stalled (lastSlice ?? turnToken is the watchdog's slice).
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
    // Unsaved body of a posted note (addNote) or a staged hook continuation
    // (continueAdmission); a row is one kind, so never both. Held until claim,
    // whose claimNotes is its only reader and clears it once saved natively.
    text: v.optional(v.string()),
    // Separates cancelled payloads from fresh admission before cleanup runs.
    noteEpoch: v.optional(v.number()),
    from: v.optional(v.string()),
    // A joined group generates from its newest result (messageId, at
    // newestSequence), but notes precede its earliest native member. Set only
    // by releaseGroup, all three together; read only by claim.
    join: v.optional(
      v.object({
        newestSequence: v.number(),
        earliestId: v.string(),
        earliestSequence: v.number(),
      }),
    ),
    runId: v.id("runs"),
    // Read by wake (result/note make a subagent_result turn; user/parent make a
    // user turn), claim (non-user kinds merge consecutively; a user row ends
    // it) and hooks.origins.origins (note and continue label their message,
    // result falls through to its run).
    kind: v.union(
      v.literal("user"),
      v.literal("result"),
      v.literal("parent"),
      v.literal("note"),
      v.literal("continue"),
    ),
  })
    .index("by_message", ["messageId"])
    .index("by_run_ready", ["assignmentId", "runId", "passive"])
    .index("by_assignment_ready", ["assignmentId", "passive", "noteEpoch", "sequence"]),
  // A run outlives an individual turn: results and subsequent delegations spend
  // the same launch/hop budget. Results are ready independently of siblings.
  runs: defineTable({
    // Accepted requests record exact native task links and a UTF-8 preview.
    // Synthetic budgets (validation/tests) need no root. Tree reads only owned roots.
    rootAssignmentId: v.optional(v.id("assignments")),
    // History can observe cancellation even for a terminal-but-undelivered
    // old request no longer present in the root's current run/ready inbox.
    rootCancellationEpoch: v.optional(v.number()),
    taskMessageId: v.optional(v.string()),
    taskPreview: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    turnEndedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    errorCode: v.optional(errorCode),
    resultMessageId: v.optional(v.string()),
    // Sticky observation failure, read by usageReporting and later tree projections.
    usagePartial: v.optional(v.boolean()),
    // Read by claim/watchdog and betweenSlices. Children inherit this same run id.
    settings: v.optional(settingsSnapshot),
    // Run snapshot shared by every root/descendant/result turn. A beforeTurn
    // hook may choose its agent model at run start; later turns only read it.
    // Read at claim, never replaced by a subsequent send's thread policy.
    models: v.optional(modelOverrides),
    // Bit sets over agent indexes: startedAgents marks agents that began in this
    // run (claim isRunStart); routingAgents marks the owner of a pending
    // beforeTurn model decision (hooks.routing.routing/settleRouting).
    startedAgents: v.int64(),
    routingAgents: v.int64(),
    // Read by continueAdmission against limits.continuesPerRun.
    continues: v.number(),
    // Read by reserve against limits.sideRunsPerRun.
    sideRuns: v.number(),
    launches: v.number(),
    hops: v.number(),
    cancelled: v.boolean(),
  }).index("by_root", ["rootAssignmentId"]),
  // Durable facts have separate lifecycles. Effect receipts expire; proposals
  // retire with their pause refs, and attachment attestations track native files.
  // The union avoids dummy lease/result fields on ownership records and adds
  // no table. Native Agent still owns file bytes, metadata and refcounts.
  receipts: defineTable(
    v.union(
      // No expiry: an unanswered pause remains answerable beyond receipt retention.
      // Read only by its exact assignment reference, deleted when that ref retires.
      v.object({ kind: v.literal("proposal"), result: storedProposal }),
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
    // Captured atomically with the initial native task; tree never reads bodies.
    taskMessageId: v.optional(v.string()),
    taskPreview: v.optional(v.string()),
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
    // Read by reserve (cohort lookup), delivery and release (whole cohort).
    group: v.optional(v.string()),
    // A wait "all" member's join state; absent means wait "each". One-way:
    // reserve writes "open"; the launching slice's sealGroups moves its run's
    // open members to "sealed"; markGroupReady moves ONE representative of a
    // sealed, fully delivered cohort to "ready"; releaseGroup moves every
    // member to "joined". Read by reserve (wait/closed checks), settlement
    // (any unjoined member fences R3), delivery, readiness and release.
    join: v.optional(
      v.union(v.literal("open"), v.literal("sealed"), v.literal("ready"), v.literal("joined")),
    ),
    // The exact native question id is recorded with its native save and read
    // for verification before delivery. `asking` itself is the open-question fence.
    questionMessageId: v.optional(v.string()),
    // Read by interaction admission against limits.messagesPerChild.
    messagesReceived: v.number(),
    // Read by parent-note admission; accepted notes alone spend this lifetime cap.
    parentNotesSent: v.number(),
    // Read by parent-note admission for the minimum interval; retries replay first.
    lastParentNoteAt: v.optional(v.number()),
    childAssignmentId: v.optional(v.id("assignments")),
    childThreadId: v.optional(v.string()),
    // Recorded with native final saves, cleared on every new turn claim, and
    // read by settlement verification: only the last turn may supply a result.
    childResultMessageId: v.optional(v.string()),
    // Host-verified outcome of the last ended turn, retained while descendants
    // or inbox work fence settlement. Claim clears it before the next turn and
    // every terminal transition (settleRunState, cancel) clears it for good.
    // Read only by idle settlement; no native transcript is scanned or copied.
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
    // Set by the first claim of the child's first turn; never derived, because
    // the "started" event of that turn leaves the event ring after 3 turns.
    startedAt: v.optional(v.number()),
    resultMessageId: v.optional(v.string()),
    // Native notifications can share a millisecond; this parent-local order
    // selects the latest exact anchor when the closed group is released.
    // Written on accepted join members only; read only by releaseGroup.
    resultSequence: v.optional(v.number()),
    // The newest LIMITS.runEvents transitions (subagents/runs.ts appendEvent).
    // The public finishedAt/deliveryAt are derived from it (`runTimes`): the
    // terminal and delivery events are always the newest two.
    events: v.array(runEvent),
  })
    .index("by_result_message", ["resultMessageId"])
    .index("by_dedup", ["dedupKey"])
    .index("by_run", ["runId"])
    .index("by_root_sequence", ["rootAssignmentId", "sequence"])
    .index("by_root_status", ["rootAssignmentId", "status"])
    // Launch admission also pins the epoch to bound outstanding result work
    // across request budgets without reading cancelled delivery history.
    .index("by_parent_delivery", [
      "actorAssignmentId",
      "side",
      "deliveryStatus",
      "rootCancellationEpoch",
      "parentRunId",
    ])
    // Every reader pins actor, epoch and one join state: settlementBlocked
    // (open/sealed/ready), releaseGroups (ready [+ run]), sealGroups (open + run).
    .index("by_join", ["actorAssignmentId", "rootCancellationEpoch", "join", "parentRunId"])
    // Cohort readers (reserve, delivery, release) pin all three fields; runTree
    // reads the parentRunId prefix, i.e. one root request's whole tree.
    .index("by_group", ["parentRunId", "actorAssignmentId", "group"]),
});
