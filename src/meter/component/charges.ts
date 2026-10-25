import { v, getDocumentSize, type Infer } from "convex/values";
import type { DefaultFunctionArgs, FunctionReference } from "convex/server";
import { Workpool, vOnCompleteArgs } from "@convex-dev/workpool";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { attribution, status, source, breakdowns, reason } from "./schema.js";
import { resolveBreakdowns } from "../breakdowns.js";
import { jobs, lookupJob, deliveryJob } from "./contracts.js";
import {
  updateAggregates,
  deleteAggregates,
  deleteCost,
  threadCount,
  rootOf,
} from "./aggregates.js";
import { LIMITS, integer, text, chargeKey } from "../limits.js";

const pool = new Workpool(components.workpool, { maxParallelism: LIMITS.maxParallelism });
type Jobs = Infer<typeof jobs>;
/** Workpool's runtime supports function handles; its enqueueAction type only names references.
 * src/client/index.ts:576-579 passes a function:// handle through unchanged. */
function actionHandle<A extends DefaultFunctionArgs>(handle: string) {
  return handle as unknown as FunctionReference<"action", "internal", A>;
}
type DeliveryJob = Infer<ReturnType<typeof v.object<typeof deliveryJob>>>;
type Delivery = Doc<"deliveries">;

async function find(ctx: Pick<QueryCtx, "db">, key: string) {
  chargeKey(key);
  return await ctx.db
    .query("charges")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}
function validateJobs(config: Jobs) {
  integer(config.maxAttempts, LIMITS.maxAttempts, "ATTEMPTS");
  if (!config.maxAttempts) throw new Error("INVALID_ATTEMPTS");
  // Function handles are opaque Convex strings, bounded separately from labels.
  for (const handle of [config.lookup, config.deliver])
    if (handle) text(handle, "HANDLE", LIMITS.maxKeyBytes);
}
function final(row: Doc<"charges">) {
  return row.status === "settled" || row.status === "corrected";
}
/**
 * Billing is separate from budgeting. A known cost (inline, settlement or
 * lookup) that is `unknown` only because it overflowed its thread or exceeded
 * the per-charge cap is still delivered to sinks: it is unknown for the gate,
 * billed because the amount is known. Estimates are billed once corrected.
 */
function billable(row: Doc<"charges">) {
  return (
    row.nanos !== undefined &&
    (final(row) || (row.status === "unknown" && row.source !== "estimate"))
  );
}
function resolved(row: Doc<"charges">) {
  return row.source !== "estimate" || row.status === "unknown";
}
/** Settled and acknowledged by every sink (vacuously true without sinks).
 * `corrected` is not terminal: a settlement or lookup may still replace it. */
function isTerminal(row: Doc<"charges">) {
  return (
    row.status === "settled" &&
    row.nanos !== undefined &&
    row.sinkState.every((sink) => !sink.pending && sink.deliveredNanos === row.nanos)
  );
}

async function stale(ctx: MutationCtx, row: Doc<"charges">, operation: string, revision: number) {
  if (row.lastStale?.operation === operation && row.lastStale.revision === revision) return row;
  const lastStale = { operation, revision };
  await ctx.db.patch(row._id, { lastStale });
  return { ...row, lastStale };
}

type Outcome = Omit<Doc<"charges">, "operations" | "terminal" | "sinkState"> & {
  sinkState: (Doc<"charges">["sinkState"][number] & { attempts: number; failed: boolean })[];
};
/** Caller-facing charge: retry state is joined from the <=4 outbox rows (one
 * bounded index read), so failures never have to rewrite the large charge row. */
async function outcome(ctx: Pick<QueryCtx, "db">, row: Doc<"charges">): Promise<Outcome> {
  const { operations: _operations, terminal: _terminal, ...result } = row;
  const pending = await ctx.db
    .query("deliveries")
    .withIndex("by_key", (q) => q.eq("key", row.key))
    .take(LIMITS.maxSinks);
  return {
    ...result,
    sinkState: row.sinkState.map((sink) => {
      const delivery = pending.find((entry) => entry.sink === sink.name);
      return { ...sink, attempts: delivery?.attempts ?? 0, failed: delivery?.failed ?? false };
    }),
  };
}

/**
 * Start one delivery job for a sink. The job drains up to LIMITS.sinkBatch due
 * events of that sink, so a burst shares requests; jobs that find nothing
 * claimed return without contacting the sink. `claim` identifies the rows the
 * job takes, so its Workpool onComplete can count a crash as a failed attempt.
 * `crashes` counts consecutive deaths before claiming (see deliveryComplete).
 * onComplete also runs on success, to delete the job's claim marker.
 */
async function enqueueDrain(
  ctx: MutationCtx,
  sink: string,
  config: Jobs,
  runAt: number,
  crashes = 0,
) {
  if (!config.deliver) return;
  const claim = crypto.randomUUID();
  await pool.enqueueAction(
    ctx,
    actionHandle<DeliveryJob>(config.deliver),
    { sink, claim, jobs: config },
    {
      retry: false,
      runAt,
      onComplete: internal.charges.deliveryComplete,
      context: { sink, claim, jobs: config, crashes },
    },
  );
}
function backoff(attempts: number) {
  return Math.min(LIMITS.maxBackoffMs, LIMITS.backoffMs * LIMITS.backoffBase ** attempts);
}

/** Outbox snapshots are immutable until acknowledged, including on uncertain
 * delivery. A pending event exists on the charge exactly while its outbox row
 * exists; the row is the copy delivery jobs read. */
async function prepareSinks(ctx: MutationCtx, row: Doc<"charges">, config: Jobs, changed = false) {
  const sinkState = row.sinkState.map((sink) => ({ ...sink }));
  const due: string[] = [];
  if (billable(row) && row.nanos !== undefined)
    for (const sink of sinkState) {
      if (sink.pending || sink.deliveredNanos === row.nanos) continue;
      sink.revision++;
      sink.pending = {
        externalId:
          sink.deliveredNanos === undefined
            ? row.key
            : `${row.key}${LIMITS.deltaSeparator}${sink.revision}`,
        revision: sink.revision,
        nanos: row.nanos - (sink.deliveredNanos ?? 0),
        totalNanos: row.nanos,
      };
      await ctx.db.insert("deliveries", {
        sink: sink.name,
        key: row.key,
        event: sink.pending,
        attribution: row.attribution,
        provider: row.provider,
        attempts: 0,
        limited: false,
        failed: false,
        dueAt: Date.now(),
      });
      due.push(sink.name);
    }
  const next = { ...row, sinkState };
  const terminal = isTerminal(next);
  if (changed || due.length || terminal !== row.terminal)
    await ctx.db.patch(row._id, { sinkState, terminal });
  for (const sink of due)
    await enqueueDrain(ctx, sink, config, Date.now() + LIMITS.deliveryWindowMs);
  return { ...next, terminal };
}

export const get = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await find(ctx, key);
    return row && (await outcome(ctx, row));
  },
});

export const create = mutation({
  args: {
    key: v.string(),
    attribution,
    provider: v.string(),
    breakdowns,
    profile: v.optional(v.string()),
    quantity: v.optional(v.number()),
    status,
    source,
    nanos: v.optional(v.number()),
    credits: v.optional(v.number()),
    reason: v.optional(reason),
    sinks: v.array(v.string()),
    maxThreadCharges: v.number(),
    jobs,
  },
  handler: async (ctx, args): Promise<null> => {
    const enabledBreakdowns = resolveBreakdowns(args.breakdowns);
    text(args.key, "KEY", LIMITS.maxKeyBytes);
    text(args.provider, "PROVIDER");
    for (const value of Object.values(args.attribution))
      if (value !== undefined) text(value, "ATTRIBUTION");
    if (args.profile) text(args.profile, "PROFILE");
    if (args.quantity !== undefined) integer(args.quantity, LIMITS.maxQuantity, "QUANTITY");
    if (args.credits !== undefined) integer(args.credits, LIMITS.maxQuantity, "CREDITS");
    if (args.nanos !== undefined)
      integer(
        args.nanos,
        args.reason === "OVER_CAP" ? LIMITS.maxBilledNanos : LIMITS.maxChargeNanos,
        "NANOS",
      );
    integer(args.maxThreadCharges, LIMITS.maxThreadCharges, "THREAD_CHARGES");
    if (!args.maxThreadCharges) throw new Error("INVALID_THREAD_CHARGES");
    if (args.reason && args.status !== "unknown") throw new Error("INVALID_REASON");
    validateJobs(args.jobs);
    if (args.sinks.length > LIMITS.maxSinks || new Set(args.sinks).size !== args.sinks.length)
      throw new Error("INVALID_SINKS");
    for (const sink of args.sinks) text(sink, "SINK");
    const existing = await find(ctx, args.key);
    if (existing) {
      // The component-wide key is immutable. Replays return the latest charge,
      // but cannot move another subject's charge or attach a different provider.
      const names = new Set([
        ...Object.keys(existing.attribution),
        ...Object.keys(args.attribution),
      ]);
      if (
        existing.provider !== args.provider ||
        [...names].some(
          (name) =>
            existing.attribution[name as keyof typeof args.attribution] !==
            args.attribution[name as keyof typeof args.attribution],
        )
      )
        throw new Error("KEY_CONFLICT");
      if (
        args.source === "estimate" &&
        (existing.status === "settled" || existing.status === "unknown")
      )
        await stale(ctx, existing, "estimate", 0);
      return null;
    }
    // No deployment-wide capacity: the only count read is this ROOT THREAD's
    // own trees (3 unbounded counts, root + <=5 children each on a lazy root).
    // It serializes charge creation within one root thread, never across
    // threads or subjects. Past the cap the charge is still recorded, as
    // `unknown`, so the budget gate denies instead of a swallowed error
    // admitting unmetered work.
    const root = rootOf(args.attribution);
    const full = root !== undefined && (await threadCount(ctx, root)) >= args.maxThreadCharges;
    const id = await ctx.db.insert("charges", {
      key: args.key,
      attribution: args.attribution,
      provider: args.provider,
      breakdowns: enabledBreakdowns,
      profile: args.profile,
      quantity: args.quantity,
      status: full ? "unknown" : args.status,
      source: args.source,
      nanos: args.nanos,
      credits: args.credits,
      reason: full ? "THREAD_CAPACITY" : args.reason,
      sinkState: args.sinks.map((name) => ({ name, revision: 0 })),
      terminal: false,
      revision: 0,
      operations: [],
    });
    const row = (await ctx.db.get(id))!;
    await updateAggregates(ctx, row);
    await prepareSinks(ctx, row, args.jobs);
    return null;
  },
});

async function change(
  ctx: MutationCtx,
  row: Doc<"charges">,
  patch: Partial<Doc<"charges">>,
  config: Jobs,
) {
  // Only amount/state transitions advance the outcome revision. Attachment and
  // sink acknowledgements do not change the amount represented by that revision.
  patch = { ...patch, revision: row.revision + 1 };
  const next = { ...row, ...patch };
  await ctx.db.patch(row._id, patch);
  if (row.nanos !== next.nanos || row.status !== next.status || row.source !== next.source)
    await updateAggregates(ctx, next, row);
  return await prepareSinks(ctx, next, config);
}

function replay(row: Doc<"charges">, key: string) {
  text(key, "OPERATION_KEY", LIMITS.maxKeyBytes);
  const receipt = row.operations.find((entry) => entry.key === key);
  if (receipt) return receipt.outcome;
  // Never evict a receipt: a delayed replay of an evicted key would become a
  // new correction and could raise an estimate again. At 32 distinct keys the
  // charge fails closed for new operations, while every old key stays replayable.
  // Each outcome is <8 KiB (bounded fields/four sinks, no nested ledger):
  // 32 * (8 KiB + 256-byte key + 128-byte wrapper) + 8 KiB = 276 KiB < 1 MiB.
  // One charge per transaction adds <280 KiB read and <840 KiB for at most
  // three row patches to the aggregate budget (aggregates.ts).
  if (row.operations.length >= LIMITS.maxOperations) throw new Error("OPERATION_CAPACITY");
}

async function remember(ctx: MutationCtx, row: Doc<"charges">, key: string): Promise<Outcome> {
  const result = await outcome(ctx, row);
  await ctx.db.patch(row._id, { operations: [...row.operations, { key, outcome: result }] });
  return result;
}

export const update = mutation({
  args: {
    key: v.string(),
    operation: v.union(v.literal("correct"), v.literal("settle")),
    operationKey: v.string(),
    quantity: v.optional(v.number()),
    nanos: v.number(),
    credits: v.optional(v.number()),
    jobs,
  },
  handler: async (ctx, args): Promise<Outcome> => {
    validateJobs(args.jobs);
    integer(args.nanos, LIMITS.maxBilledNanos, "NANOS");
    // Above the per-charge cap the amount is kept but becomes unknown, exactly
    // as at creation: recording never throws on an unpriceable business amount.
    const over = args.nanos > LIMITS.maxChargeNanos;
    if (args.quantity !== undefined) integer(args.quantity, LIMITS.maxQuantity, "QUANTITY");
    if (args.credits !== undefined) integer(args.credits, LIMITS.maxQuantity, "CREDITS");
    const row = await find(ctx, args.key);
    if (!row) throw new Error("CHARGE_NOT_FOUND");
    const previous = replay(row, args.operationKey);
    if (previous) return previous;
    const save = (next: Doc<"charges">) => remember(ctx, next, args.operationKey);
    // Authoritative results always outrank estimates, including concurrent
    // corrections. Settled amounts are immutable even for another settlement.
    if (
      row.status === "settled" &&
      args.operation === "settle" &&
      row.nanos === args.nanos &&
      row.credits === args.credits
    )
      return await save(row);
    if (row.status === "settled")
      return await save(await stale(ctx, row, args.operation, row.revision));
    if (args.operation === "correct") {
      if (
        row.status === "unknown" ||
        (row.lookupUntil !== undefined && Date.now() >= row.lookupUntil)
      ) {
        const expired =
          row.status === "unknown" ? row : await change(ctx, row, { status: "unknown" }, args.jobs);
        return await save(await stale(ctx, expired, args.operation, row.revision));
      }
      if (row.nanos === args.nanos && row.quantity === args.quantity && row.status === "corrected")
        return await save(row);
    }
    return await save(
      await change(
        ctx,
        row,
        {
          nanos: args.nanos,
          quantity: args.quantity ?? row.quantity,
          credits: args.credits ?? row.credits,
          status: over ? "unknown" : args.operation === "correct" ? "corrected" : "settled",
          source: args.operation === "correct" ? "estimate" : "settlement",
          // THREAD_CAPACITY routes projections and must never change.
          ...(over && row.reason !== "THREAD_CAPACITY" ? { reason: "OVER_CAP" as const } : {}),
        },
        args.jobs,
      ),
    );
  },
});

export const attach = mutation({
  args: {
    key: v.string(),
    operationKey: v.string(),
    requestId: v.string(),
    lookupMs: v.number(),
    jobs,
  },
  handler: async (ctx, args): Promise<Outcome> => {
    text(args.requestId, "REQUEST_ID");
    validateJobs(args.jobs);
    integer(args.lookupMs, LIMITS.maxLookupMs, "LOOKUP_WINDOW");
    if (!args.lookupMs) throw new Error("INVALID_LOOKUP_WINDOW");
    const row = await find(ctx, args.key);
    if (!row) throw new Error("CHARGE_NOT_FOUND");
    const previous = replay(row, args.operationKey);
    if (previous) return previous;
    if (row.providerRequestId) {
      if (row.providerRequestId !== args.requestId) throw new Error("REQUEST_ID_CONFLICT");
      return await remember(ctx, row, args.operationKey);
    }
    const until = args.jobs.lookup && !resolved(row) ? Date.now() + args.lookupMs : undefined;
    await ctx.db.patch(row._id, {
      providerRequestId: args.requestId,
      lookupUntil: until,
      lookupAttempt: until ? 0 : undefined,
    });
    if (until && args.jobs.lookup) {
      await pool.enqueueAction(
        ctx,
        actionHandle<Infer<ReturnType<typeof v.object<typeof lookupJob>>>>(args.jobs.lookup),
        {
          key: row.key,
          provider: row.provider,
          requestId: args.requestId,
          until,
          attempt: 0,
          jobs: args.jobs,
        },
        { retry: false },
      );
      // A separate one-shot deadline survives a crashed lookup worker. It does
      // no provider work, and reads the exact recorded id rather than scanning.
      await ctx.scheduler.runAt(until, internal.charges.expire, { id: row._id });
    }
    return await remember(
      ctx,
      {
        ...row,
        providerRequestId: args.requestId,
        lookupUntil: until,
        lookupAttempt: until ? 0 : undefined,
      },
      args.operationKey,
    );
  },
});

export const expire = internalMutation({
  args: { id: v.id("charges") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row?.lookupUntil && Date.now() >= row.lookupUntil && !resolved(row))
      await change(ctx, row, { status: "unknown" }, { maxAttempts: LIMITS.maxAttempts });
  },
});

export const lookupResult = mutation({
  args: { ...lookupJob, nanos: v.optional(v.number()), credits: v.optional(v.number()) },
  handler: async (ctx, args): Promise<null> => {
    validateJobs(args.jobs);
    integer(args.attempt, LIMITS.maxAttempts, "ATTEMPT");
    const row = await find(ctx, args.key);
    if (
      !row ||
      row.status === "settled" ||
      row.provider !== args.provider ||
      row.lookupUntil !== args.until ||
      row.providerRequestId !== args.requestId
    )
      return null;
    // A real response already in flight may arrive after expiry. Do not start
    // new provider work then, but retain that evidence rather than losing it.
    if (args.nanos !== undefined) {
      integer(args.nanos, LIMITS.maxChargeNanos, "NANOS");
      if (args.credits !== undefined) integer(args.credits, LIMITS.maxQuantity, "CREDITS");
      await change(
        ctx,
        row,
        {
          status: "settled",
          source: "lookup",
          nanos: args.nanos,
          ...(args.credits === undefined ? {} : { credits: args.credits }),
        },
        args.jobs,
      );
    } else if (row.status === "unknown" || args.attempt !== row.lookupAttempt) {
      return null;
    } else if (Date.now() >= args.until) {
      await change(ctx, row, { status: "unknown" }, args.jobs);
    } else if (args.attempt + 1 < args.jobs.maxAttempts && args.jobs.lookup) {
      // Duplicate callbacks cannot admit another retry chain.
      await ctx.db.patch(row._id, { lookupAttempt: args.attempt + 1 });
      const delay = Math.min(
        LIMITS.maxBackoffMs,
        LIMITS.backoffMs * LIMITS.backoffBase ** args.attempt,
      );
      const { nanos: _nanos, credits: _credits, ...job } = args;
      await pool.enqueueAction(
        ctx,
        actionHandle<Infer<ReturnType<typeof v.object<typeof lookupJob>>>>(args.jobs.lookup),
        { ...job, attempt: args.attempt + 1 },
        { retry: false, runAt: Math.min(Date.now() + delay, args.until) },
      );
    } else {
      await ctx.db.patch(row._id, { lookupAttempt: args.attempt + 1 });
    }
    return null;
  },
});

/** Due, unclaimed, non-failed events of one sink, oldest due first. */
function dueRows(ctx: Pick<QueryCtx, "db">, sink: string) {
  return ctx.db
    .query("deliveries")
    .withIndex("by_due", (q) =>
      q.eq("sink", sink).eq("failed", false).eq("claim", undefined).lte("dueAt", Date.now()),
    )
    .take(LIMITS.sinkBatch);
}

/**
 * Called by the host delivery action. Takes <=100 due outbox rows of one sink
 * (<=2 KiB each: event, <=6 attribution labels of 128 bytes, 256-byte key):
 * <=200 KiB read and written, 100 docs. Never reads charge rows. The claim
 * marker records that this job took its batch, even after every row is
 * acknowledged and deleted, so a later crash charges only the job's own rows.
 */
export const claimDeliveries = mutation({
  args: deliveryJob,
  handler: async (ctx, args) => {
    validateJobs(args.jobs);
    text(args.sink, "SINK");
    text(args.claim, "CLAIM");
    const marker = await ctx.db
      .query("claims")
      .withIndex("by_claim", (q) => q.eq("claim", args.claim))
      .unique();
    if (!marker) await ctx.db.insert("claims", { claim: args.claim });
    const rows = await dueRows(ctx, args.sink);
    for (const row of rows) await ctx.db.patch(row._id, { claim: args.claim });
    return rows.map((row) => ({
      ...row.event,
      key: row.key,
      attribution: row.attribution,
      provider: row.provider,
    }));
  },
});

/**
 * One failed delivery attempt for each row, shared by sink errors and crashed
 * jobs (onComplete). A 429 with Retry-After reschedules at that delay without
 * consuming an attempt once; the next consecutive 429 consumes one, so a sink
 * that keeps answering 429 still reaches `failed` after maxAttempts+1 tries.
 * Retries are on demand: at most one job per distinct (sink, due time), and
 * none once a row has failed. Rows are outbox rows only (<=100, small).
 */
async function failRows(
  ctx: MutationCtx,
  rows: Delivery[],
  result: { retryAfterMs?: number; rateLimited: boolean },
  config: Jobs,
) {
  const now = Date.now();
  const retries = new Map<string, { sink: string; dueAt: number }>();
  for (const row of rows) {
    const free = result.rateLimited && result.retryAfterMs !== undefined && !row.limited;
    const attempts = row.attempts + (free ? 0 : 1);
    const failed = attempts >= config.maxAttempts;
    const dueAt =
      now + (free ? result.retryAfterMs! : Math.max(result.retryAfterMs ?? 0, backoff(attempts)));
    await ctx.db.patch(row._id, {
      attempts,
      failed,
      limited: result.rateLimited,
      claim: undefined,
      dueAt,
    });
    if (!failed) retries.set(`${row.sink}\u0000${dueAt}`, { sink: row.sink, dueAt });
  }
  for (const { sink, dueAt } of retries.values()) await enqueueDrain(ctx, sink, config, dueAt);
}

/** Acknowledge one delivered event: the only delivery path that patches a charge. */
async function acknowledge(ctx: MutationCtx, row: Delivery, config: Jobs) {
  await ctx.db.delete(row._id);
  const charge = await find(ctx, row.key);
  const sink = charge?.sinkState.find((entry) => entry.name === row.sink);
  if (!charge || !sink?.pending || sink.pending.externalId !== row.event.externalId) return;
  const totalNanos = sink.pending.totalNanos;
  const sinkState = charge.sinkState.map((entry) =>
    entry.name === row.sink
      ? { name: entry.name, revision: entry.revision, deliveredNanos: totalNanos }
      : entry,
  );
  // May enqueue the next signed delta if the amount changed during delivery.
  await prepareSinks(ctx, { ...charge, sinkState }, config, true);
}

/**
 * Results for <=LIMITS.ackBatch events of one claimed batch. An acknowledgement
 * reads and rewrites its charge (<=280 KiB): 16 * 280 KiB =4.4 MiB read and
 * written, plus <=16 new outbox rows and Workpool admissions. Stale results
 * (a different claim holds the row, or it is gone) are ignored.
 */
export const deliveryResult = mutation({
  args: {
    sink: v.string(),
    claim: v.string(),
    keys: v.array(v.string()),
    ok: v.boolean(),
    retryAfterMs: v.optional(v.number()),
    rateLimited: v.boolean(),
    jobs,
  },
  handler: async (ctx, args): Promise<null> => {
    validateJobs(args.jobs);
    if (args.keys.length > LIMITS.ackBatch) throw new Error("INVALID_KEYS");
    if (args.retryAfterMs !== undefined)
      integer(args.retryAfterMs, LIMITS.maxLookupMs, "RETRY_AFTER");
    const failures: Delivery[] = [];
    for (const key of args.keys) {
      chargeKey(key);
      const row = await ctx.db
        .query("deliveries")
        .withIndex("by_key", (q) => q.eq("key", key).eq("sink", args.sink))
        .unique();
      if (!row || row.claim !== args.claim) continue;
      if (args.ok) await acknowledge(ctx, row, args.jobs);
      else failures.push(row);
    }
    await failRows(ctx, failures, args, args.jobs);
    return null;
  },
});

/**
 * Workpool onComplete for every delivery job. It deletes the job's claim
 * marker. A failed or cancelled job that claimed counts as one failed attempt
 * for the rows still carrying its claim, exactly like deliveryResult(ok:false),
 * and charges no other row: a job that acknowledged its batch and then died
 * charges nothing. A job that died before claiming touched nothing, so it is
 * re-enqueued (no attempt charged) at most maxAttempts-1 consecutive times;
 * past that its due rows wait for the next event's job or retrySinks.
 * Reads <=1 marker and <=100 outbox rows, never a charge row.
 */
export const deliveryComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ ...deliveryJob, crashes: v.number() })),
  handler: async (ctx, { context, result }) => {
    const marker = await ctx.db
      .query("claims")
      .withIndex("by_claim", (q) => q.eq("claim", context.claim))
      .unique();
    if (marker) await ctx.db.delete(marker._id);
    if (result.kind === "success") return null;
    if (marker) {
      const rows = await ctx.db
        .query("deliveries")
        .withIndex("by_claim", (q) => q.eq("claim", context.claim))
        .take(LIMITS.sinkBatch);
      await failRows(ctx, rows, { rateLimited: false }, context.jobs);
    } else if (context.crashes + 1 < context.jobs.maxAttempts)
      await enqueueDrain(
        ctx,
        context.sink,
        context.jobs,
        Date.now() + backoff(context.crashes + 1),
        context.crashes + 1,
      );
    return null;
  },
});

export const retrySinks = mutation({
  args: { key: v.string(), jobs },
  handler: async (ctx, args): Promise<null> => {
    validateJobs(args.jobs);
    const row = await find(ctx, args.key);
    if (!row) throw new Error("CHARGE_NOT_FOUND");
    for (const sink of row.sinkState) {
      if (!sink.pending) continue;
      const delivery = await ctx.db
        .query("deliveries")
        .withIndex("by_key", (q) => q.eq("key", row.key).eq("sink", sink.name))
        .unique();
      // An in-flight job keeps its claim; resetting it would resend the batch.
      if (!delivery || delivery.claim !== undefined) continue;
      await ctx.db.patch(delivery._id, {
        attempts: 0,
        failed: false,
        limited: false,
        dueAt: Date.now(),
      });
      await enqueueDrain(ctx, sink.name, args.jobs, Date.now());
    }
    return null;
  },
});

/**
 * Host-driven retention. Deletes settled charges whose sinks all acknowledged
 * (index by_terminal, no scan of live rows) created before `before`, with
 * their aggregate entries, so remaining totals stay exact. No rescheduling:
 * the host calls it again while `more`.
 *
 * Transaction bound: each candidate is charged its real size (getDocumentSize,
 * <=280 KiB with receipts) plus the worst-case aggregate delete cost of its
 * projections (aggregates.ts deleteCost: 8*D+4 docs each, D=10 thread-scoped,
 * D=24 subject/run-scoped, 2 KiB per node). The batch stops before 16k docs /
 * 12 MiB of reads; writes are at most half the node reads (4*D+2 per
 * projection) plus each deleted row, so also <=12 MiB / 8k docs. A default
 * charge (3 projections: 84 + 196 + 196) costs <=476 nodes (952 KiB): >=9 per
 * call with full 280-KiB receipt ledgers, >=12 with small rows; a fully
 * opted-in one (8: 3*84 + 5*196) <=1,232 nodes (2.4 MiB): >=4. `limit` caps the count.
 */
export const prune = mutation({
  args: { before: v.number(), limit: v.optional(v.number()), minAgeMs: v.number() },
  handler: async (ctx, { before, limit = LIMITS.pruneLimit, minAgeMs }) => {
    integer(before, LIMITS.maxTimestamp, "BEFORE");
    integer(minAgeMs, LIMITS.pruneMinAgeMs, "MIN_AGE");
    // Guard: pruning lowers run and subject totals, so a cutoff inside an
    // active run or budget window would re-admit spend. Hosts may lower it.
    if (before > Date.now() - minAgeMs) throw new Error("PRUNE_TOO_RECENT");
    integer(limit, LIMITS.maxPruneLimit, "LIMIT");
    if (!limit) throw new Error("INVALID_LIMIT");
    let deleted = 0;
    let docs = 0;
    let bytes = 0;
    while (true) {
      // Re-query after each delete: reads observe this transaction's deletes,
      // so the next eligible row is always the first one. <=501 index queries.
      const row = await ctx.db
        .query("charges")
        .withIndex("by_terminal", (q) => q.eq("terminal", true).lt("_creationTime", before))
        .first();
      if (!row) return { deleted, more: false };
      const nodes = deleteCost(row);
      const cost = getDocumentSize(row) + nodes * LIMITS.nodeBytes;
      if (
        deleted === limit ||
        docs + nodes + 1 > LIMITS.pruneReadDocs ||
        bytes + cost > LIMITS.pruneReadBytes
      )
        return { deleted, more: true };
      docs += nodes + 1;
      bytes += cost;
      await deleteAggregates(ctx, row);
      await ctx.db.delete(row._id);
      deleted++;
    }
  },
});
