import { v, type Infer } from "convex/values";
import type { DefaultFunctionArgs, FunctionReference } from "convex/server";
import { Workpool } from "@convex-dev/workpool";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { attribution, status, source } from "./schema.js";
import { jobs, lookupJob, deliveryJob } from "./contracts.js";
import { updateAggregates, chargeCount } from "./aggregates.js";
import { LIMITS, integer, text, chargeKey } from "../limits.js";

const pool = new Workpool(components.workpool, { maxParallelism: LIMITS.maxParallelism });
type Jobs = Infer<typeof jobs>;
/** Workpool's runtime supports function handles; its enqueueAction type only names references.
 * src/client/index.ts:576-579 passes a function:// handle through unchanged. */
function actionHandle<A extends DefaultFunctionArgs>(handle: string) {
  return handle as unknown as FunctionReference<"action", "internal", A>;
}
type DeliveryJob = Infer<ReturnType<typeof v.object<typeof deliveryJob>>>;

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
function resolved(row: Doc<"charges">) {
  return row.source !== "estimate" || row.status === "unknown";
}

async function stale(ctx: MutationCtx, row: Doc<"charges">, operation: string, revision: number) {
  if (row.lastStale?.operation === operation && row.lastStale.revision === revision) return row;
  const lastStale = { operation, revision };
  await ctx.db.patch(row._id, { lastStale });
  return { ...row, lastStale };
}

async function enqueueDelivery(
  ctx: MutationCtx,
  row: Doc<"charges">,
  sink: Doc<"charges">["sinkState"][number],
  config: Jobs,
) {
  if (!config.deliver || !sink.pending) return;
  await pool.enqueueAction(
    ctx,
    actionHandle<DeliveryJob>(config.deliver),
    {
      key: row.key,
      sink: sink.name,
      event: sink.pending,
      jobs: config,
    },
    { retry: false },
  );
}

/** Outbox snapshots are immutable until acknowledged, including on uncertain delivery. */
async function prepareSinks(ctx: MutationCtx, row: Doc<"charges">, config: Jobs) {
  if (!final(row) || row.nanos === undefined) return row;
  for (const sink of row.sinkState) {
    if (sink.pending || sink.failed || sink.deliveredNanos === row.nanos) continue;
    sink.revision++;
    sink.attempts = 0;
    sink.pending = {
      externalId:
        sink.deliveredNanos === undefined
          ? row.key
          : `${row.key}${LIMITS.deltaSeparator}${sink.revision}`,
      revision: sink.revision,
      nanos: row.nanos - (sink.deliveredNanos ?? 0),
      totalNanos: row.nanos,
    };
    await enqueueDelivery(ctx, row, sink, config);
  }
  await ctx.db.patch(row._id, { sinkState: row.sinkState });
  return row;
}

export const get = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => await find(ctx, key),
});

export const create = mutation({
  args: {
    key: v.string(),
    attribution,
    provider: v.string(),
    profile: v.optional(v.string()),
    quantity: v.optional(v.number()),
    status,
    source,
    nanos: v.optional(v.number()),
    credits: v.optional(v.number()),
    sinks: v.array(v.string()),
    maxCharges: v.number(),
    jobs,
  },
  handler: async (ctx, args): Promise<Doc<"charges">> => {
    text(args.key, "KEY", LIMITS.maxKeyBytes);
    text(args.provider, "PROVIDER");
    for (const value of Object.values(args.attribution))
      if (value !== undefined) text(value, "ATTRIBUTION");
    if (args.profile) text(args.profile, "PROFILE");
    if (args.quantity !== undefined) integer(args.quantity, LIMITS.maxQuantity, "QUANTITY");
    if (args.credits !== undefined) integer(args.credits, LIMITS.maxQuantity, "CREDITS");
    if (args.nanos !== undefined) integer(args.nanos, LIMITS.maxChargeNanos, "NANOS");
    integer(args.maxCharges, LIMITS.maxCharges, "CHARGES");
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
      return args.source === "estimate" &&
        (existing.status === "settled" || existing.status === "unknown")
        ? await stale(ctx, existing, "estimate", 0)
        : existing;
    }
    // Mount capacity bounds ALL namespaces, numeric sums (100k*$10 <=1e15
    // nanos < MAX_SAFE_INTEGER), and worst-case B-tree depth, not just one user.
    if ((await chargeCount(ctx)) >= args.maxCharges) throw new Error("METER_CAPACITY");
    const id = await ctx.db.insert("charges", {
      key: args.key,
      attribution: args.attribution,
      provider: args.provider,
      profile: args.profile,
      quantity: args.quantity,
      status: args.status,
      source: args.source,
      nanos: args.nanos,
      credits: args.credits,
      sinkState: args.sinks.map((name) => ({ name, revision: 0, attempts: 0, failed: false })),
      revision: 0,
    });
    const row = (await ctx.db.get(id))!;
    await updateAggregates(ctx, row);
    return await prepareSinks(ctx, row, args.jobs);
  },
});

async function change(
  ctx: MutationCtx,
  row: Doc<"charges">,
  patch: Partial<Doc<"charges">>,
  config: Jobs,
) {
  // Only amount/state transitions advance this fence. Sink acknowledgements
  // and request-id attachment must not invalidate a valid quantity correction.
  patch = { ...patch, revision: row.revision + 1 };
  const next = { ...row, ...patch };
  await ctx.db.patch(row._id, patch);
  if (row.nanos !== next.nanos || row.status !== next.status || row.source !== next.source)
    await updateAggregates(ctx, next, row);
  return await prepareSinks(ctx, next, config);
}

export const update = mutation({
  args: {
    key: v.string(),
    operation: v.union(v.literal("correct"), v.literal("settle")),
    revision: v.number(),
    quantity: v.optional(v.number()),
    nanos: v.number(),
    credits: v.optional(v.number()),
    jobs,
  },
  handler: async (ctx, args): Promise<Doc<"charges">> => {
    validateJobs(args.jobs);
    integer(args.nanos, LIMITS.maxChargeNanos, "NANOS");
    integer(args.revision, LIMITS.maxRevision, "REVISION");
    if (args.quantity !== undefined) integer(args.quantity, LIMITS.maxQuantity, "QUANTITY");
    if (args.credits !== undefined) integer(args.credits, LIMITS.maxQuantity, "CREDITS");
    const row = await find(ctx, args.key);
    if (!row) throw new Error("CHARGE_NOT_FOUND");
    // Authoritative results always outrank estimates, including concurrent
    // corrections. Settled amounts are immutable even for another settlement.
    if (
      row.status === "settled" &&
      args.operation === "settle" &&
      row.nanos === args.nanos &&
      row.credits === args.credits
    )
      return row;
    if (row.status === "settled") return await stale(ctx, row, args.operation, args.revision);
    if (args.operation === "correct") {
      if (
        row.status === "unknown" ||
        (row.lookupUntil !== undefined && Date.now() >= row.lookupUntil)
      ) {
        const expired =
          row.status === "unknown" ? row : await change(ctx, row, { status: "unknown" }, args.jobs);
        return await stale(ctx, expired, args.operation, args.revision);
      }
      if (args.revision !== row.revision)
        return await stale(ctx, row, args.operation, args.revision);
      if (row.nanos === args.nanos && row.quantity === args.quantity && row.status === "corrected")
        return row;
    }
    return await change(
      ctx,
      row,
      {
        nanos: args.nanos,
        quantity: args.quantity ?? row.quantity,
        credits: args.credits ?? row.credits,
        status: args.operation === "correct" ? "corrected" : "settled",
        source: args.operation === "correct" ? "estimate" : "settlement",
      },
      args.jobs,
    );
  },
});

export const attach = mutation({
  args: { key: v.string(), requestId: v.string(), lookupMs: v.number(), jobs },
  handler: async (ctx, args): Promise<Doc<"charges">> => {
    text(args.requestId, "REQUEST_ID");
    validateJobs(args.jobs);
    integer(args.lookupMs, LIMITS.maxLookupMs, "LOOKUP_WINDOW");
    if (!args.lookupMs) throw new Error("INVALID_LOOKUP_WINDOW");
    const row = await find(ctx, args.key);
    if (!row) throw new Error("CHARGE_NOT_FOUND");
    if (row.providerRequestId) {
      if (row.providerRequestId !== args.requestId) throw new Error("REQUEST_ID_CONFLICT");
      return row;
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
    return {
      ...row,
      providerRequestId: args.requestId,
      lookupUntil: until,
      lookupAttempt: until ? 0 : undefined,
    };
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

export const deliveryResult = mutation({
  args: { ...deliveryJob, ok: v.boolean(), retryAfterMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<null> => {
    validateJobs(args.jobs);
    if (args.retryAfterMs !== undefined)
      integer(args.retryAfterMs, LIMITS.maxLookupMs, "RETRY_AFTER");
    const row = await find(ctx, args.key);
    const sink = row?.sinkState.find((s) => s.name === args.sink);
    if (!row || !sink?.pending || sink.pending.externalId !== args.event.externalId) return null;
    if (args.ok) {
      sink.deliveredNanos = sink.pending.totalNanos;
      sink.pending = undefined;
      sink.attempts = 0;
      sink.failed = false;
      await ctx.db.patch(row._id, { sinkState: row.sinkState });
      await prepareSinks(ctx, row, args.jobs);
    } else {
      sink.attempts++;
      sink.failed = sink.attempts >= args.jobs.maxAttempts;
      await ctx.db.patch(row._id, { sinkState: row.sinkState });
      if (!sink.failed && args.jobs.deliver) {
        const { ok: _ok, retryAfterMs: _retry, ...job } = args;
        await pool.enqueueAction(ctx, actionHandle<DeliveryJob>(args.jobs.deliver), job, {
          retry: false,
          runAfter: Math.max(
            args.retryAfterMs ?? 0,
            Math.min(LIMITS.maxBackoffMs, LIMITS.backoffMs * LIMITS.backoffBase ** sink.attempts),
          ),
        });
      }
    }
    return null;
  },
});

export const retrySinks = mutation({
  args: { key: v.string(), jobs },
  handler: async (ctx, args): Promise<null> => {
    validateJobs(args.jobs);
    const row = await find(ctx, args.key);
    if (!row) throw new Error("CHARGE_NOT_FOUND");
    for (const sink of row.sinkState)
      if (sink.pending) {
        sink.failed = false;
        sink.attempts = 0;
        await enqueueDelivery(ctx, row, sink, args.jobs);
      }
    await ctx.db.patch(row._id, { sinkState: row.sinkState });
    return null;
  },
});
