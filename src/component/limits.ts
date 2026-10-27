/**
 * All runtime bounds live here. The two Workflow pools share the platform's
 * eight scheduled-action slots: two roots and four children leave room for
 * control jobs. Waiting workflows consume no action slot, and a root releases
 * its slot as soon as delegation is queued, so children can always progress.
 * Platform ceilings are documentation as well as a constraint on our defaults;
 * payloads stay in Agent storage rather than consuming the Workflow journal.
 * Contents: PLATFORM facts, HOST_LIMITS (defaults + hard maxima a host may
 * override), the full cancel budget arithmetic, LIMITS (fixed bounds) and
 * `resolveLimits`, which the client calls at registration. A resolved copy is
 * stored on every assignment row (`row.limits`).
 */
import { v } from "convex/values";

/** Workflow 0.4.10 / Convex documented facts, not checked by this SDK.
 * Workflow enforces its journal/step byte ceilings; only ids and small control
 * values cross our steps. These platform facts are never host overrides.
 */
export const PLATFORM = {
  convexActionMs: 30 * 60_000,
  scheduledConcurrency: 8,
} as const;

/** Host defaults and hard ceilings are paired so raising policy cannot unbound a transaction. */
export const HOST_LIMITS = {
  // Shared message admission and generation download budget, including history.
  attachmentBytes: { default: 8 << 20, max: 16 << 20 },
  // The single note admission cap is independent of the ready-work queue.
  notesPending: { default: 8, max: 24 },
  maxDepth: { default: 2, max: 2 },
  messagesPerChild: { default: 4, max: 8 },
  parentNotesPerChild: { default: 4, max: 8 },
  // Pool admission shares eight scheduled-action slots at both maxima together.
  rootLane: { default: 2, max: 4 },
  childLane: { default: 4, max: 4 },
  // Bound launches per run and outstanding result work per assignment across runs.
  runLaunches: { default: 12, max: 50 },
  runHops: { default: 24, max: 100 },
  // Bound the assignments, run records and cleanup jobs fenced by one cancel.
  activeChildrenPerRoot: { default: 5, max: 15 },
  // Bound native task saves to <=64 KiB UTF-8 (plus its text projection).
  taskLength: { default: 4_000, max: 16_000 },
  // Bound cancel run patches/inbox deletes and claim result-batch reads/deletes.
  queueLength: { default: 20, max: 100 },
  // Bound the turn journal; cancel reads only its one in-progress step, not history.
  slicesPerTurn: { default: 16, max: 64 },
  // Ledger admission touches one receipt; cap its lease horizon to one day.
  leaseMs: { default: 10 * 60_000, max: 24 * 60 * 60_000 },
} as const;

/**
 * Cancel budget at ALL host maxima:
 * C=15 live descendants; A=1+C=16 assignments. Depth never multiplies A.
 * I=A*(100 queued prompts +50 outstanding direct-child results +2 head/answer)
 * =2,432 ready rows. Launch admission counts pending deliveries and ready
 * results across request budgets; delivery cannot be blocked by user backlog.
 * N=A*24=384 passive notes are cleaned by finite separate jobs, never read here.
 * U=100 root messages +50 result budgets +3 head/answer/current +15 child
 * budgets=168 distinct runs. Cancel deduplicates these before guard/patch.
 * SDK bookkeeping reserves 64A=1,024 reads/writes at <=3 KiB read/4 KiB write
 * per row (Workflow 0.4.10 workflow.ts:350-455; Workpool 0.4.14 lib.ts:137-259).
 * Every assignment has one state patch, current-run patch, one exact event
 * delivery and one exact-id cleanup job; SDK reserves cover Workflow handoff.
 * Writes <=2I+N+5A+C+1+64A=6,368 <16,000.
 * Reads <=3I+2N+5A+2C+2+64A+U=9,368 <32,000.
 * Indexed queries <=3 child-status ranges +A inbox ranges +64A=1,043 <4,096.
 * Bytes read (KiB): ready scan/delete 2I=4,864; run guard/patch 2U*16=5,376;
 * assignments 2A*13=416; event delivery 2A*4=128; children 2C*4=120;
 * final root 2*13=26; SDK 64A*3=3,072; cleanup jobs A*4=64.
 * Total <=14,066 KiB <16,384 KiB, leaving 2,318 KiB headroom.
 * Bytes written (KiB): U*16+I+N+2A*13+A*16+2A*4+C*4+16+64A*4
 * =10,476 KiB <16 MiB. No staged hook continuation or routing locks remain.
 * Native messages/placeholders are NEVER read by cancel; cleanup is separate.
 *
 * Assignment envelope is 13 KiB, including native/system fields. The all-fields
 * fixture tests/save-bounds.fixture.ts fills every remaining writer bound:
 * approvals <=4,802 B; report <=2,635 B; metadata handles <=806 B;
 * pending generation <=1,280 B; runTurn <=258 B; names <=1,204 B;
 * model map <=510 B; limits <=309 B; remaining fields/names/overhead <=900 B.
 * Captured Workflow turn identity <=87 B (field name plus execution token).
 * Total <=12,791 B; 13,312-12,791=521 B headroom at every writer cap.
 * Native child ids need <=37 bytes (one more than UUIDs); their reference is
 * included above. Child rows use their system id, freeing the old UUID field.
 * No summary body, context ring, review history, cadence or text job is stored.
 * activeTools is excluded from save growth: write clears it first, and the
 * progress writer separately refuses a marker crossing assignmentBytes.
 * Raw note rows <=17 KiB, read only by bounded per-assignment jobs.
 * Saved controls <=1 KiB carry exact origins and are excluded from ready ranges.
 * Run metadata stays <=16 KiB including <=15 KiB settings and <=512 B models.
 *
 * Claim consumes <=152 ready rows and <=24 notes. It reads only exact native
 * anchors plus Agent's bounded merge heads, never history for control decisions.
 * Combined note/native/coordination reads stay <13 MiB at host maxima (fixture
 * tests/claim-bounds.test.ts). Native result verification reads one <=1 MiB
 * message; task <=16,000 UTF-16 units, at most one native save per delegation.
 * The run tree reads <=50 launch rows <=4 KiB each (200 KiB).
 *
 * Failed-step finalization is one transaction, including its Workflow callback.
 * The recorded failMessage handle updates the exact placeholder directly;
 * unlike finalizeMessage it never materializes persisted stream deltas or
 * reads native merge heads. Reserve four <=1 MiB placeholder reads: the outer
 * getMessagesByIds, updateMessage's get, patch read and returned get.
 * Root-only retirement probes <=152 distinct run rows *16 KiB =2,432 KiB,
 * plus ready scan/delete <=304 KiB. Reserve 256 KiB for assignment/native
 * stream metadata and 512 KiB for Workflow completion, rotation and cleanup:
 * 4,096+2,432+304+256+512=7,600 KiB <16,384 KiB.
 * Child finalization has no root-ready scan; bounded depth-two settlement
 * adds <=222 KiB instead, remaining below that root ceiling. Loop cleanup
 * reads only <=100 small id-only journal steps (50 next +50 turn/event),
 * with nested turn journals handed to upstream cleanup jobs, never read here.
 * tests/failure-bounds.test.ts measures the whole completion callback with a
 * maximum native placeholder, the full 100-step loop journal, recoverable and
 * >16 MiB persisted delta backlogs, six near-1 MiB native merge heads and all
 * 152 distinct maximum-size failed-run rows, with transaction limits enabled. Neither
 * delta count nor body size enters failure's read budget. It writes metadata
 * and one native placeholder (<1 MiB fixture), never replaying paid effects.
 */
export const LIMITS = {
  notesPending: HOST_LIMITS.notesPending.default,
  noteLength: 4_000,
  firstPromptOrder: 1,
  telemetryFlushMs: 3_000,
  filesPerMessage: 8,
  factBytes: 128,
  attachmentBytes: HOST_LIMITS.attachmentBytes.default,
  fileIdLength: 200,
  // Every function handle we store (runTurn, textConfig, pendingGeneration,
  // approvals, subagent coordinators, attachment natives), in UTF-8 bytes.
  // Convex 1.47 serializes a handle as `function://<id>#<udf path>`
  // (crates/common/src/bootstrap_model/components/handles.rs:83-90): an 11-byte
  // prefix, a <=37-byte base32 document id (value/src/id_v6.rs:35-49) and the
  // advisory path, e.g. `messages.js:addMessages`. Real agevex/Agent handles are
  // ~60-100 bytes, so 256 leaves 2.5x margin while keeping the ten handles an
  // assignment may hold to <=2.5 KiB of its envelope.
  functionHandleBytes: 256,
  // Subjects and agent names stored on assignments. The host client already narrows both to 128 UTF-8 bytes
  // (facts.ts); the component bounds its own writers independently.
  nameLength: 200,
  sandboxExitCode: 2 ** 31 - 1,
  fileMetadataBytes: 4 << 10,
  taskRepairs: 1,
  taskPromptLength: 16_000,
  agents: 64,
  assignmentBytes: 13 << 10,
  turnReportBytes: 3 << 10,
  messageIdBytes: 37,
  maxDepth: HOST_LIMITS.maxDepth.default,
  messagesPerChild: HOST_LIMITS.messagesPerChild.default,
  parentNotesPerChild: HOST_LIMITS.parentNotesPerChild.default,
  parentNoteBytes: 2 << 10,
  parentNoteIntervalMs: 5_000,
  rootLane: HOST_LIMITS.rootLane.default,
  childLane: HOST_LIMITS.childLane.default,
  slicesPerTurn: HOST_LIMITS.slicesPerTurn.default,
  turnsPerLoop: 50,
  workflowVersion: 1,
  cancelPollMs: 1_000,
  outputTokens: 4096,
  runLaunches: HOST_LIMITS.runLaunches.default,
  runHops: HOST_LIMITS.runHops.default,
  activeChildrenPerRoot: HOST_LIMITS.activeChildrenPerRoot.default,
  taskLength: HOST_LIMITS.taskLength.default,
  queueLength: HOST_LIMITS.queueLength.default,
  messageLength: 16_000,
  requestKeyLength: 200,
  // At least 2: subagents/runs.ts `runTimes` reads the terminal and delivery
  // events, which are always the newest two entries of the ring.
  runEvents: 4,
  maxDelegationPage: 50,
  // Bound approval coordination metadata even when native approval ids are huge:
  // requests store SHA-256 keys and a per-request resolved flag, never payloads.
  approvalsPerPause: 16,
  nativeCallIdLength: 1 << 20,
  nativeEnvelopeBytes: 4 << 10,
  // Separate read transactions, including Agent's SIX prefetched merge heads
  // (3 statuses * tool/non-tool; Agent src/component/messages.ts:809-845).
  // Messages: 0.5 MiB page + 1 MiB overshoot + 6*1 MiB heads + 0.25 MiB
  // coordination = 7.75 MiB <16 MiB. Count: <=100 page rows + six heads.
  // Origin lookup adds <=100*1 KiB controls +100*4 KiB results +16 KiB
  // ownership =516 KiB and <=201 reads/queries; combined <8.26 MiB <16 MiB.
  // Stream deltas: 2*1 MiB metadata + 8 MiB native page + 1 MiB delta
  // overshoot + 0.25 MiB coordination = 11.25 MiB <16 MiB. Agent's fixed
  // 8 MiB page reads <=200 deltas (src/component/streams.ts:listDeltas).
  // streams.list retains the upstream 100-metadata-row exception (spec §9b).
  streamCursors: 2,
  // The public `messages` reader takes its page size from the client. Without a
  // server-side clamp, one request for a huge page of large tool results would
  // exceed the 16 MiB query read limit and that query would fail outright.
  // Native pagination stops early at `maximumBytesRead` and returns a cursor.
  // Agent owns the merged index lookahead and stream read bounds (spec §9b).
  messagePage: 100,
  messagePageBytes: 512 << 10,
  cleanupMessageBytes: 512 << 10,
  leaseMs: HOST_LIMITS.leaseMs.default,
  receiptRetentionMs: 7 * 24 * 60 * 60_000,
  receiptResultBytes: 64 << 10,
  // Query + delete reads + the continuation probe: (2*50+1)*64 KiB
  // = 6.3125 MiB for results, leaving >1 MiB for receipt metadata under 8 MiB.
  purgeBatch: 50,
  purgeIntervalMs: 60 * 60_000,
  streamThrottleMs: 0,
  modelRetries: 0,
  modelOverrides: 8,
  modelOverridesBytes: 512,
  modelIdLength: 200,
  modelAllowlist: 100,
} as const;

/** Only these policy bounds are tunable; internal safety/platform facts are not. */
export const limitsValidator = v.object({
  // resolveLimits fills every policy field at registration, so a stored row
  // always carries the complete resolved set and readers never fall back.
  attachmentBytes: v.number(),
  notesPending: v.number(),
  maxDepth: v.number(),
  messagesPerChild: v.number(),
  parentNotesPerChild: v.number(),
  rootLane: v.number(),
  childLane: v.number(),
  runLaunches: v.number(),
  runHops: v.number(),
  activeChildrenPerRoot: v.number(),
  taskLength: v.number(),
  queueLength: v.number(),
  slicesPerTurn: v.number(),
  leaseMs: v.number(),
});
export type Limits = { [K in keyof typeof limitsValidator.fields]: number };

/** Message backlog + outstanding direct-child results + answer + reserved head
 * (or approval continuation). Launch bounds result work across request budgets;
 * Each result occupies its own row. The head is ready but excluded from queuedMessages.
 */
export function readyRowLimit(limits: Pick<Limits, "queueLength" | "runLaunches">) {
  return limits.queueLength + limits.runLaunches + 2;
}

/** Fail at registration, before any accepted prompt can launch background work. */
export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !Object.prototype.hasOwnProperty.call(limitsValidator.fields, key) ||
      !Number.isSafeInteger(value) ||
      value <= 0
    )
      throw new Error("INVALID_LIMITS: expected positive integer host bounds");

    const maximum = HOST_LIMITS[key as keyof Limits].max;

    if (value > maximum) throw new Error(`INVALID_LIMITS: ${key} exceeds maximum ${maximum}`);
  }

  const merged = Object.fromEntries(
    Object.keys(limitsValidator.fields).map((key) => [
      key,
      overrides[key as keyof Limits] ?? LIMITS[key as keyof Limits],
    ]),
  ) as Limits;

  if (merged.rootLane + merged.childLane > PLATFORM.scheduledConcurrency)
    throw new Error("INVALID_LIMITS: lanes exceed scheduled concurrency");

  return merged;
}
