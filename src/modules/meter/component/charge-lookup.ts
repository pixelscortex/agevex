/**
 * Provider request attachment, one-shot expiry and read-only lookup results.
 * These handlers serve the stable registrations in charges.ts and preserve
 * request-id, deadline and attempt fences. Only billing evidence is retried;
 * no paid provider operation is started or repeated here.
 */
import { v, type Infer } from "convex/values";
import type { MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { AttachArgs, ExpireArgs, LookupResultArgs } from "./charge-contracts.js";
import { lookupJob } from "../shared/contracts.js";
import { LIMITS, integer, text } from "../shared/limits.js";
import { find, resolved, replay, remember, type Outcome } from "./charge-records.js";
import { pool, actionHandle, validateJobs } from "./jobs.js";
import { change } from "./charge-updates.js";

/** Attach one immutable provider request, then admit lookup and its independent deadline. */
export async function attachCharge(ctx: MutationCtx, args: AttachArgs): Promise<Outcome> {
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

  await ctx.db.patch("charges", row._id, {
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
}

/** Mark unresolved evidence unknown at its recorded one-shot deadline. */
export async function expireCharge(ctx: MutationCtx, { id }: ExpireArgs): Promise<void> {
  const row = await ctx.db.get("charges", id);

  if (row?.lookupUntil && Date.now() >= row.lookupUntil && !resolved(row))
    await change(ctx, row, { status: "unknown" }, { maxAttempts: LIMITS.maxAttempts });
}

/** Retain late evidence but fence duplicate empty callbacks before scheduling another lookup. */
export async function recordLookupResult(ctx: MutationCtx, args: LookupResultArgs): Promise<null> {
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
    // Same rule as update: a real amount above the per-charge cap is kept
    // (and billed, source "lookup") as unknown/OVER_CAP, never discarded.
    integer(args.nanos, LIMITS.maxBilledNanos, "NANOS");
    const over = args.nanos > LIMITS.maxChargeNanos;

    if (args.credits !== undefined) integer(args.credits, LIMITS.maxQuantity, "CREDITS");

    await change(
      ctx,
      row,
      {
        status: over ? "unknown" : "settled",
        source: "lookup",
        nanos: args.nanos,
        ...(args.credits === undefined ? {} : { credits: args.credits }),
        // THREAD_CAPACITY routes projections and must never change.
        ...(over && row.reason !== "THREAD_CAPACITY" ? { reason: "OVER_CAP" as const } : {}),
      },
      args.jobs,
    );
  } else if (row.status === "unknown" || args.attempt !== row.lookupAttempt) {
    return null;
  } else if (Date.now() >= args.until) {
    await change(ctx, row, { status: "unknown" }, args.jobs);
  } else if (args.attempt + 1 < args.jobs.maxAttempts && args.jobs.lookup) {
    // Duplicate callbacks cannot admit another retry chain.
    await ctx.db.patch("charges", row._id, { lookupAttempt: args.attempt + 1 });

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
    await ctx.db.patch("charges", row._id, { lookupAttempt: args.attempt + 1 });
  }

  return null;
}
