// Persisted state for the managed assignment/turn runtime and the bounded
// asynchronous subagent runs it coordinates, plus the return validators the
// host client imports from the package.
//
// Native boundary / ownership split: the coordination state below is
// Agevex-owned. The `threadId`/`promptMessageId`/`childResultMessageId` it
// stores are only *references* into the host's native Agent component's
// transcripts, which Agevex does not own or mutate directly. Message bodies,
// assistant output and streams stay in the native transcript; this schema
// never duplicates them and never stores a task or result body.
// Nothing here is a transcript, a completion record or a task result.
//
// Lifecycle as implemented. The four tables have distinct lifecycles and are
// deliberately not grouped:
// - `pending` rows are created by `queue.accept` and by a successful subagent
//   result delivery, and are consumed — deleted — when `wake` selects them,
//   before the turn is published and enqueued.
// - `assignments` rows are created by `queue.accept` (root threads) or by a
//   delegation launch (child threads) and updated in place as coordination
//   advances (accept, claim, finish, ambiguity, watchdog escalation, run
//   counters, the spent per-prompt launch allowance). They have no deletion,
//   completion, retention, expiry or repair API.
// - `receipts` rows are immutable records of acceptance: written once and never
//   updated or completed, with no cleanup API.
// - `subagentRuns` rows are written once at launch and then patched by at most
//   three bounded transitions (started, terminal, delivery). They are never
//   deleted, so this table grows without bound for the lifetime of a backend;
//   there is no cleanup or retention API today.
// `recovery_required` is a sticky terminal-for-this-slice state that blocks new
// messages until the host acts out of band.

import { defineSchema, defineTable } from "convex/server";
import { v, type Validator } from "convex/values";

/**
 * Origin of an accepted message, preserved through `pending`, the published
 * turn and `queue.claim`.
 *
 * - `user`: a caller-triggered prompt, or the task text a root delegated to a
 *   child. Only `user` turns of a **root** assignment may acquire the managed
 *   delegation tool.
 * - `subagent_result`: a child result (or failure notification) delivered into
 *   the root transcript. It may start a follow-up turn, but that turn cannot
 *   delegate again and cannot reset the original allowance.
 *
 * This is an origin, not a completion state: a result-triggered turn is a real
 * generation, not an acknowledgement that the root read anything.
 */
export const turnOrigin = v.union(v.literal("user"), v.literal("subagent_result"));
/**
 * Turn state of the single in-flight turn, distinct from assignment state.
 *
 * - `idle`: no turn dispatched; `turnToken`/`promptMessageId` are cleared and a
 *   backlog row (if any) is woken on the next accept, finish or delivery.
 * - `queued`: one turn holds `turnToken`/`promptMessageId` and is enqueued in
 *   Workpool. Queue wait is not execution time.
 * - `running`: a turn claimed ownership via `queue.claim` and is inside the
 *   execution watchdog window.
 * - `recovery_required`: sticky. Ambiguous, failed or revoked execution. Never
 *   taken over, never replayed; `queue.accept` rejects with `RECOVERY_REQUIRED`.
 *
 * Assignment state is separate and additive in this slice: assignments are
 * always `open` and only a turn ever reaches a terminal state. A child turn
 * reaching `recovery_required` never marks its root assignment failed.
 */
export const turnStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("idle"),
  v.literal("recovery_required"),
);
/**
 * Sanitized failure code for the last turn; `null` whenever the assignment is not
 * in `recovery_required`. Deliberately coarse: raw provider, model or tool
 * exceptions are never persisted or returned, so clients must not parse them.
 */
export const errorCode = v.union(
  v.null(),
  v.literal("GENERATION_FAILED"),
  v.literal("AUTHORIZATION_DENIED"),
  v.literal("EXECUTION_AMBIGUOUS"),
);
/**
 * Sanitized failure code of one subagent run, or of its single delivery attempt.
 * Never a raw provider, model, tool or host exception. A completed run with an
 * accepted delivery is `null`; a terminal failure keeps its own code even when
 * the failure notification was later accepted into the parent queue.
 */
export const runErrorCode = v.union(
  v.null(),
  v.literal("GENERATION_FAILED"),
  v.literal("EXECUTION_AMBIGUOUS"),
  v.literal("EMPTY_RESULT"),
  v.literal("RESULT_UNVERIFIED"),
  v.literal("AUTHORIZATION_DENIED"),
  v.literal("ROOT_UNAVAILABLE"),
  v.literal("DELIVERY_FAILED"),
);
/**
 * Why a delegation attempt was refused without starting a run. Returned to the
 * model as a tool result, never as a root-generation failure. `TASK_LIMIT`
 * covers both bounds a single attempt can exceed: the task length checked by
 * the host tool, and the per-accepted-user-prompt launch allowance checked
 * by `subagents.reserve`.
 */
export const denialCode = v.union(
  v.literal("ACTIVE_LIMIT"),
  v.literal("TASK_LIMIT"),
  v.literal("FORBIDDEN"),
  v.literal("STALE_TURN"),
  v.literal("DELEGATION_CONFLICT"),
);
/** Lifecycle of a child run, derived from persisted transitions only. */
export const runStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);
/**
 * Outcome of the single bounded attempt to hand a terminal run to the parent.
 * `accepted` means the native parent transcript *and* the component queue
 * committed the result — not that the root read, understood or acknowledged it.
 */
export const deliveryStatus = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("failed"),
  v.literal("blocked"),
);
/** One persisted transition of a run, projected into the frontend event list. */
export const runPhase = v.union(
  v.literal("queued"),
  v.literal("started"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("result_accepted"),
  v.literal("delivery_failed"),
  v.literal("delivery_blocked"),
);
/**
 * One stored transition. `at` is when the transition was persisted, never a
 * model-internal timestamp; `errorCode` is null for non-failure phases.
 */
export const runEvent = v.object({
  phase: runPhase,
  at: v.number(),
  errorCode: runErrorCode,
});
/**
 * Return shape of `open`/`send` and of the dedup replay path. `accepted` is the
 * only literal on purpose: a receipt acknowledges durable queueing, not
 * generated output, not a read, not a finished turn and not task completion.
 */
export const receipt = v.object({
  assignmentId: v.string(),
  threadId: v.string(),
  receiptId: v.string(),
  status: v.literal("accepted"),
});
/**
 * Additive coordination view returned by the `activity` query. `assignmentStatus`
 * is a fixed literal because no completion policy exists yet; `turnStatus`,
 * `queuedMessages` and `errorCode` describe queue/turn progress only.
 * `subagents` counts the root's own child runs and is all-zero for a
 * Main-only registration, so old clients keep reading a superset shape.
 */
export const subagentCounts = v.object({
  /** queued + running child runs of this root. */
  active: v.number(),
  /** completed + failed child runs of this root. */
  history: v.number(),
  /** active + history; the number of delegations ever accepted by this root. */
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
/** Ownership/identity projection of an assignment, shared by `assignment` and `claim`. */
export const scope = v.object({
  assignmentId: v.string(),
  threadId: v.string(),
  subject: v.string(),
  agent: v.string(),
});
/**
 * Public coordination projection of one child run, returned by the authorized
 * `delegations` query. Deliberately carries no child thread id, no delivery or
 * execution token, and no task or result text: the result itself lives in the
 * native parent transcript and is reachable through `resultMessageId`.
 */
export const subagentRun = v.object({
  runId: v.string(),
  agent: v.string(),
  status: runStatus,
  deliveryStatus,
  createdAt: v.number(),
  startedAt: v.union(v.null(), v.number()),
  finishedAt: v.union(v.null(), v.number()),
  deliveryAt: v.union(v.null(), v.number()),
  /** Native id of the parent notification message, once delivery was accepted. */
  resultMessageId: v.union(v.null(), v.string()),
  errorCode: runErrorCode,
  events: v.array(v.object({ ...runEvent.fields, runId: v.string(), agent: v.string() })),
});

/**
 * Local pagination-result validator.
 *
 * Declared here rather than imported so the component keeps no dependency on the
 * native Agent component: this mirrors the native page envelope exactly and is
 * what both the component `delegations` query and the authorized host wrapper
 * return.
 */
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

export default defineSchema({
  // One row per managed thread, created by the first `accept` for a root thread
  // or by a delegation launch for a child thread.
  // Owner: the host's native Agent thread identified by `threadId`. `subject` and
  // `agent` are the trusted ownership pair established on first acceptance and
  // re-validated by later non-replay accepts; host reads authorize on `subject`
  // alone (`activity` checks `subject` only), while execution ownership is
  // guarded by the turn token and turn state.
  assignments: defineTable({
    /** Trusted caller identity the host authorization policy returned. */
    subject: v.string(),
    /** Registered managed agent that owns this thread. */
    agent: v.string(),
    /** Native thread id; the reference into the host Agent component's transcript. */
    threadId: v.string(),
    /** Host internal action handle (`runTurn`) forwarded verbatim to dispatch. */
    runTurn: v.string(),
    /** State of the single in-flight turn; never a task/assignment outcome. */
    turnStatus,
    /** Sanitized reason for `recovery_required`; null outside that state. */
    errorCode,
    /** Pending backlog size: counts `pending` rows only, not the dispatched turn. */
    queuedMessages: v.number(),
    /** Next sequence number handed to a newly inserted backlog row. */
    nextSequence: v.number(),
    /** Monotonic turn counter; combined with the id it forms the turn token. */
    nextTurn: v.number(),
    /** Token of the dispatched turn; uniqueness is what blocks duplicate ownership. */
    turnToken: v.optional(v.string()),
    /** Native message id anchored to that turn, so later arrivals cannot enter it. */
    promptMessageId: v.optional(v.string()),
    /** Origin of the dispatched or last turn; see {@link turnOrigin}. */
    turnOrigin: v.optional(turnOrigin),
    /** Set only on child assignments: the root assignment this run belongs to. */
    rootAssignmentId: v.optional(v.id("assignments")),
    /** Set only on child assignments: the `subagentRuns` row that owns it. */
    runId: v.optional(v.string()),
    /** queued + running child runs of this root; undefined means zero. */
    activeRuns: v.optional(v.number()),
    /** completed + failed child runs of this root; undefined means zero. */
    historyRuns: v.optional(v.number()),
    /** Next monotonic child-run sequence handed out by `subagents.reserve`. */
    nextRunSequence: v.optional(v.number()),
    /**
     * Turn token of the last root turn to reserve a child launch. Written by
     * `subagents.reserve` in the same transaction as the run row and the active
     * counter, never cleared. The token/count pair is retained across prompt
     * acceptance, claim, finish and child settlement; only a successful
     * reservation replaces it.
     *
     * One accepted user prompt maps to exactly one claimed turn, so this is the
     * per-prompt fanout key: another tool call on that same turn is refused
     * once the per-prompt launch allowance
     * (`MAX_DELEGATIONS_PER_USER_PROMPT`) is spent, whatever
     * state those children reached; the next accepted user prompt claims a new
     * turn token and therefore a new allowance, and a `subagent_result`
     * continuation is refused earlier as a non-user turn. It is not restored
     * when a child fails, completes or fails to deliver, and it rolls back with
     * the whole launch when the native thread creation or `attach` fails.
     *
     * {@link delegatedTurnCount} is the spent side of the pair. A legacy row
     * with the matching token but no count has already spent one launch.
     */
    delegatedTurnToken: v.optional(v.string()),
    /**
     * Launches already accepted for the last stored
     * {@link delegatedTurnToken}, retained with that token and written only by
     * a successful reservation in the same transaction as the run row.
     *
     * Optional for rows written before this counter existed: a row that carries
     * the matching token without a count has already spent one launch, so a
     * legacy root is treated as having two of three left rather than three.
     * For a different current turn token, the stored count is ignored: the new
     * allowance starts at zero, and its first successful reservation replaces
     * the stored pair with the new token and a count of one.
     */
    delegatedTurnCount: v.optional(v.number()),
    // Lookup by thread for assignment, accept replay and activity. This index is
    // an access path, not a uniqueness constraint; "one row per thread" is an
    // invariant upheld by `accept`, which creates the row on first use.
  }).index("by_thread", ["threadId"]),
  // Ordered backlog of accepted-but-not-yet-dispatched messages.
  pending: defineTable({
    /** Owning assignment; a row only ever enqueues work for this assignment. */
    assignmentId: v.id("assignments"),
    /** Native message id to generate from; the body stays in the native thread. */
    messageId: v.string(),
    /** Arrival order within the assignment; FIFO head is selected by `wake`. */
    sequence: v.number(),
    /** What triggered this row; copied onto the turn by `wake`. */
    origin: v.optional(turnOrigin),
    // Head-of-queue read in `wake`. The selected row is deleted as part of the
    // same transaction that anchors the native message id on the turn, so one
    // backlog entry cannot be anchored to a second turn and a failed dispatch
    // is not silently re-anchored. This is queue-entry bookkeeping, not an
    // exactly-once guarantee about provider, model or tool side effects.
  }).index("by_assignment_sequence", ["assignmentId", "sequence"]),
  // Append-only idempotency ledger for `open`/`send`.
  receipts: defineTable({
    /** Trusted subject the key is scoped to; cross-subject keys never collide. */
    subject: v.string(),
    /** Host-supplied caller dedup key. */
    requestKey: v.string(),
    /** Hash of the operation/target/body; a mismatch is a conflict, not a replay. */
    fingerprint: v.string(),
    /** Assignment created or reused by the accepted request. */
    assignmentId: v.id("assignments"),
    /** Thread the request was accepted into. */
    threadId: v.string(),
    // Point read for duplicate detection and for replaying the original receipt.
    // Rows are immutable and are never deleted, updated or completed by the
    // component: a receipt records acceptance only.
  }).index("by_subject_key", ["subject", "requestKey"]),
  // One row per accepted child delegation. Deliberately the only new table: run
  // counters live on the root `assignments` row and the transition projection is
  // a bounded array on the run itself, so there is no counters/events table and
  // no second transcript.
  subagentRuns: defineTable({
    /** Public opaque run id handed to the model and returned by `delegations`. */
    runId: v.string(),
    /** Scoped dedup fingerprint: actor assignment, turn token and tool call id. */
    dedupKey: v.string(),
    /** Hash of the requested child agent and task; a mismatch is a conflict. */
    payloadFingerprint: v.string(),
    /** Root assignment that owns the run and the counters. */
    rootAssignmentId: v.id("assignments"),
    /** Assignment that issued the delegation (equal to the root at depth 1). */
    actorAssignmentId: v.id("assignments"),
    /** Child assignment created by the launch; absent until the native thread exists. */
    childAssignmentId: v.optional(v.id("assignments")),
    /** Native child thread; a reference only, never a child transcript endpoint. */
    childThreadId: v.optional(v.string()),
    /** Native id of the child's verified final message; never returned publicly. */
    childResultMessageId: v.optional(v.string()),
    /** Child agent name that the model requested. */
    agent: v.string(),
    /** Root agent name, server-derived from the root assignment. */
    rootAgent: v.string(),
    /** Agent that issued the delegation; equals `rootAgent` at depth 1. */
    actorAgent: v.string(),
    /** Trusted root owner; must equal the subject the host policy returns. */
    subject: v.string(),
    status: runStatus,
    deliveryStatus,
    errorCode: runErrorCode,
    /** One-shot delivery capability minted at launch, stored, never returned. */
    deliveryToken: v.string(),
    /** Host `coordinate` handle used for the one bounded scheduled notification. */
    coordinateHandle: v.string(),
    /** Host `runTurn` handle the child turn is dispatched through. */
    runTurn: v.string(),
    createdAt: v.number(),
    /**
     * Monotonic creation order within the root, handed out by `reserve` from the
     * root's counter. Unique per root, so it is a total order and therefore an
     * exact, filter-free pagination key; `createdAt` stays the wall-clock value.
     */
    sequence: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    deliveryAt: v.optional(v.number()),
    /** Native id of the accepted parent notification message. */
    resultMessageId: v.optional(v.string()),
    /** Bounded transition projection; see {@link runEvent}. */
    events: v.array(runEvent),
    // Scoped duplicate tool call: one tool call id per actor turn maps to at
    // most one run. "One launch per tool call" is an invariant upheld by
    // `subagents.reserve`, not a uniqueness constraint of the index.
  })
    .index("by_dedup", ["dedupKey"])
    // Point read from `queue.claim` and from delivery context lookups.
    .index("by_run", ["runId"])
    // Newest-first history page for the authorized `delegations` query.
    .index("by_root_sequence", ["rootAssignmentId", "sequence"]),
});
