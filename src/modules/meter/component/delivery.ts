/**
 * Bounded outbox claims, acknowledgements and failure/crash accounting.
 * Registered delivery mutations in charges.ts delegate here in the same
 * transaction. Claim markers distinguish crashes before and after admission;
 * acknowledgements alone load charge rows, in bounded batches of at most 16.
 */
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type {
  ClaimDeliveriesArgs,
  DeliveryResultArgs,
  DeliveryCompleteArgs,
  RetrySinksArgs,
} from "./charge-contracts.js";
import { LIMITS, integer, text, chargeKey } from "../shared/limits.js";
import { find } from "./charge-records.js";
import { enqueueDrain, backoff, validateJobs, type Jobs } from "./jobs.js";
import { prepareSinks } from "./outbox.js";

type Delivery = Doc<"deliveries">;
type DeliveryEvent = Delivery["event"] & Pick<Delivery, "key" | "attribution" | "provider">;

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
export async function claimDeliveryBatch(
  ctx: MutationCtx,
  args: ClaimDeliveriesArgs,
): Promise<DeliveryEvent[]> {
  validateJobs(args.jobs);
  text(args.sink, "SINK");
  text(args.claim, "CLAIM");

  const marker = await ctx.db
    .query("claims")
    .withIndex("by_claim", (q) => q.eq("claim", args.claim))
    .unique();

  if (!marker) await ctx.db.insert("claims", { claim: args.claim });

  const rows = await dueRows(ctx, args.sink);

  for (const row of rows) await ctx.db.patch("deliveries", row._id, { claim: args.claim });

  return rows.map((row) => ({
    ...row.event,
    key: row.key,
    attribution: row.attribution,
    provider: row.provider,
  }));
}

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

    await ctx.db.patch("deliveries", row._id, {
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
  await ctx.db.delete("deliveries", row._id);
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
export async function recordDeliveryResult(
  ctx: MutationCtx,
  args: DeliveryResultArgs,
): Promise<null> {
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
}

/**
 * Workpool onComplete for every delivery job. It deletes the job's claim
 * marker. A failed or cancelled job that claimed counts as one failed attempt
 * for the rows still carrying its claim, exactly like deliveryResult(ok:false),
 * and charges no other row: a job that acknowledged its batch and then died
 * charges nothing. A job that died before claiming touched nothing, so it is
 * re-enqueued (no attempt charged) up to maxAttempts-1 consecutive times; the
 * last such crash charges one attempt to the sink's due rows (<=100).
 * Reads <=1 marker and <=100 outbox rows, never a charge row.
 */
export async function completeDelivery(
  ctx: MutationCtx,
  { context, result }: DeliveryCompleteArgs,
): Promise<null> {
  const marker = await ctx.db
    .query("claims")
    .withIndex("by_claim", (q) => q.eq("claim", context.claim))
    .unique();

  if (marker) await ctx.db.delete("claims", marker._id);

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
  // The last consecutive pre-claim crash: the job can evidently never run
  // (e.g. a broken worker export), so the due rows it would have claimed
  // take one attempt. Each such cycle is <=maxAttempts jobs and consumes an
  // attempt, so rows still reach `failed` instead of staying due forever.
  else await failRows(ctx, await dueRows(ctx, context.sink), { rateLimited: false }, context.jobs);

  return null;
}

/** Reset only unclaimed pending sink events after an explicit host retry request. */
export async function retryPendingSinks(ctx: MutationCtx, args: RetrySinksArgs): Promise<null> {
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

    await ctx.db.patch("deliveries", delivery._id, {
      attempts: 0,
      failed: false,
      limited: false,
      dueAt: Date.now(),
    });

    await enqueueDrain(ctx, sink.name, args.jobs, Date.now());
  }

  return null;
}
