import { createFunctionHandle, internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "./component/_generated/component.js";
import { lookupJob, deliveryJob } from "./component/contracts.js";
import { LIMITS, integer, nanos, resolveLimits, text } from "./limits.js";
import type {
  Attribution,
  ChargeHandle,
  Cost,
  MeterOptions,
  Provider,
  ReadCtx,
  ScopedMeter,
  UnknownReason,
  WriteCtx,
} from "./types.js";
import { openRouterCost } from "./helpers.js";
import { SinkDeliveryError } from "./sinks.js";
import { requireBreakdown, resolveBreakdowns } from "./breakdowns.js";
import type { BudgetSlot, UsageSlot } from "../client/slots.js";

export function inline(
  decode: NonNullable<Provider["inline"]> = ({ providerMetadata }) => {
    const usd = openRouterCost(providerMetadata);
    return usd === undefined ? undefined : { usd };
  },
): Provider {
  return { inline: decode };
}

function lookupMs(provider: Provider) {
  return provider.lookupFor === "1h"
    ? LIMITS.lookupMs
    : provider.lookupFor === "1d"
      ? LIMITS.maxLookupMs
      : (provider.lookupFor ?? LIMITS.lookupMs);
}
/** Amounts up to maxBilledNanos are representable; above maxChargeNanos the
 * mutation or `capped` turns them into `unknown` / OVER_CAP, keeping the amount. */
function costNanos(provider: Provider, cost: Cost) {
  if ("usd" in cost && "credits" in cost) throw new Error("AMBIGUOUS_COST");
  if ("usd" in cost) return { nanos: nanos(cost.usd, LIMITS.maxBilledNanos) };
  integer(cost.credits, LIMITS.maxQuantity, "CREDITS");
  if (!provider.credits) throw new Error("CREDIT_RATE_REQUIRED");
  return {
    nanos: nanos(cost.credits * provider.credits.usdPerCredit, LIMITS.maxBilledNanos),
    credits: cost.credits,
  };
}
type Priced = { nanos?: number; credits?: number; reason?: UnknownReason };
/** Keep a known amount above the per-charge cap: unknown for the gate, still billed. */
function capped(priced: { nanos: number; credits?: number }): Priced {
  return priced.nanos > LIMITS.maxChargeNanos ? { ...priced, reason: "OVER_CAP" } : priced;
}
/** Above the per-charge cap is OVER_CAP; any other malformed amount is INVALID_COST. */
function unpriced(error: unknown): { reason: UnknownReason } {
  return {
    reason:
      error instanceof Error && error.message === "INVALID_NANOS" ? "OVER_CAP" : "INVALID_COST",
  };
}
/**
 * Core records model steps under `message.provider ?? "model"` and swallows
 * meter errors (src/client/runtime.ts ~1245), so a throw here would drop the
 * charge and the budget gate would admit unmetered work. Every business
 * condition that prevents pricing becomes an `unknown` charge with a reason
 * instead; `check` denies while any unknown charge exists.
 */
function priceInline(
  provider: Provider | undefined,
  evidence: Parameters<NonNullable<Provider["inline"]>>[0],
): Priced {
  if (!provider) return { reason: "PROVIDER_NOT_REGISTERED" };
  let cost: Cost | undefined;
  try {
    cost = provider.inline?.(evidence);
  } catch {
    return { reason: "DECODE_FAILED" };
  }
  if (!cost) return { reason: "NO_COST" };
  try {
    return capped(costNanos(provider, cost));
  } catch (error) {
    return unpriced(error);
  }
}
/** Same rule for estimates, which managed tools reach through core's slot. */
function priceEstimate(
  provider: Provider | undefined,
  profile: string | undefined,
  quantity: number,
): Priced {
  if (!provider) return { reason: "PROVIDER_NOT_REGISTERED" };
  if (!profile) return {};
  const price = provider.profiles?.[profile];
  if (!price) return { reason: "PROFILE_NOT_REGISTERED" };
  try {
    return capped({ nanos: nanos(price.usd * quantity, LIMITS.maxBilledNanos) });
  } catch (error) {
    return unpriced(error);
  }
}

export function defineMeter(component: ComponentApi, options: MeterOptions) {
  const limits = resolveLimits(options.limits);
  const breakdowns = resolveBreakdowns(options.breakdowns);
  const providers = Object.entries(options.providers);
  if (!providers.length || providers.length > LIMITS.maxProviders)
    throw new Error("INVALID_PROVIDERS");
  for (const [name, provider] of providers) {
    text(name, "PROVIDER");
    const profiles = Object.entries(provider.profiles ?? {});
    if (profiles.length > LIMITS.maxProfiles) throw new Error("INVALID_PROFILES");
    for (const [profile, price] of profiles) {
      text(profile, "PROFILE");
      text(price.unit, "UNIT");
      nanos(price.usd);
    }
    if (provider.credits) nanos(provider.credits.usdPerCredit);
    integer(lookupMs(provider), LIMITS.maxLookupMs, "LOOKUP_WINDOW");
    if (!lookupMs(provider)) throw new Error("INVALID_LOOKUP_WINDOW");
    if (provider.lookup && !options.workers?.lookup) throw new Error("LOOKUP_WORKER_REQUIRED");
  }
  const sinks = (options.sinks ?? []).map((sink, index) => ({
    ...sink,
    name: sink.name ?? `sink:${index}`,
  }));
  if (sinks.length > LIMITS.maxSinks || new Set(sinks.map((s) => s.name)).size !== sinks.length)
    throw new Error("INVALID_SINKS");
  for (const sink of sinks) text(sink.name, "SINK");
  if (sinks.length && !options.workers?.deliver) throw new Error("DELIVERY_WORKER_REQUIRED");

  function registered(name: string) {
    text(name, "PROVIDER");
    return Object.prototype.hasOwnProperty.call(options.providers, name)
      ? options.providers[name]
      : undefined;
  }
  function providerFor(name: string) {
    const provider = registered(name);
    if (!provider) throw new Error("PROVIDER_NOT_REGISTERED");
    return provider;
  }
  async function jobs() {
    return {
      maxAttempts: limits.maxAttempts,
      ...(options.workers?.lookup
        ? { lookup: await createFunctionHandle(options.workers.lookup) }
        : {}),
      ...(options.workers?.deliver
        ? { deliver: await createFunctionHandle(options.workers.deliver) }
        : {}),
    };
  }
  async function authorize(ctx: ReadCtx, attribution: Partial<Attribution>) {
    for (const value of Object.values(attribution))
      if (value !== undefined) text(value, "ATTRIBUTION");
    await options.authorize?.(ctx, attribution);
  }

  function scope(ctx: WriteCtx, attribution: Attribution): ScopedMeter {
    text(attribution.subject, "SUBJECT");
    /** `provider` is undefined for an unregistered name: the charge exists as
     * `unknown`, and only a USD settlement can resolve it. */
    function handle(key: string, provider: Provider | undefined): ChargeHandle {
      return {
        key,
        get: async () => {
          await authorize(ctx, attribution);
          return await ctx.runQuery(component.charges.get, { key });
        },
        attach: async ({ requestId, key: operationKey }) => {
          text(operationKey, "OPERATION_KEY", LIMITS.maxKeyBytes);
          await authorize(ctx, attribution);
          return await ctx.runMutation(component.charges.attach, {
            key,
            requestId,
            operationKey,
            lookupMs: lookupMs(provider ?? {}),
            jobs: { ...(await jobs()), ...(!provider?.lookup ? { lookup: undefined } : {}) },
          });
        },
        correct: async ({ quantity, key: operationKey }) => {
          text(operationKey, "OPERATION_KEY", LIMITS.maxKeyBytes);
          await authorize(ctx, attribution);
          integer(quantity, LIMITS.maxQuantity, "QUANTITY");
          const row = await ctx.runQuery(component.charges.get, { key });
          const price = row?.profile && provider?.profiles?.[row.profile];
          if (!price) throw new Error("PROFILE_REQUIRED");
          return await ctx.runMutation(component.charges.update, {
            key,
            operation: "correct",
            operationKey,
            quantity,
            nanos: nanos(price.usd * quantity, LIMITS.maxBilledNanos),
            jobs: await jobs(),
          });
        },
        settle: async (cost) => {
          text(cost.key, "OPERATION_KEY", LIMITS.maxKeyBytes);
          await authorize(ctx, attribution);
          return await ctx.runMutation(component.charges.update, {
            key,
            operation: "settle",
            operationKey: cost.key,
            ...costNanos(provider ?? {}, cost),
            jobs: await jobs(),
          });
        },
      };
    }
    return {
      // Malformed keys, names and quantities are caller bugs and still throw;
      // unpriceable amounts and unregistered names are recorded `unknown`.
      estimate: async (name, args) => {
        await authorize(ctx, attribution);
        const provider = registered(name);
        text(args.key, "KEY", LIMITS.maxKeyBytes);
        integer(args.quantity, LIMITS.maxQuantity, "QUANTITY");
        const priced = priceEstimate(provider, args.profile, args.quantity);
        await ctx.runMutation(component.charges.create, {
          key: args.key,
          attribution,
          provider: name,
          breakdowns,
          ...(args.profile ? { profile: args.profile } : {}),
          quantity: args.quantity,
          status: priced.reason ? "unknown" : "estimate",
          source: "estimate",
          ...priced,
          sinks: sinks.map((s) => s.name),
          maxThreadCharges: limits.maxThreadCharges,
          jobs: await jobs(),
        });
        return handle(args.key, provider);
      },
      record: async (name, args) => {
        await authorize(ctx, attribution);
        const provider = registered(name);
        text(args.key, "KEY", LIMITS.maxKeyBytes);
        const priced = priceInline(provider, {
          usage: args.usage,
          providerMetadata: args.providerMetadata,
        });
        await ctx.runMutation(component.charges.create, {
          key: args.key,
          attribution,
          provider: name,
          breakdowns,
          status: priced.reason ? "unknown" : "settled",
          source: "inline",
          ...priced,
          sinks: sinks.map((s) => s.name),
          maxThreadCharges: limits.maxThreadCharges,
          jobs: await jobs(),
        });
        return handle(args.key, provider);
      },
    };
  }

  async function check(
    ctx: ReadCtx,
    args: { subject: string; runId?: string },
    budgetPolicy = options.budgets,
  ) {
    await authorize(ctx, args);
    const policy = await budgetPolicy?.(args);
    // Budget caps can cover many charges, so the bound is the exact-integer
    // ceiling, not the per-charge cap. A total at or beyond 2^53 is still
    // >= any such cap, so imprecision there can only deny, never admit.
    if (policy && (!Number.isFinite(policy.maxUsd) || policy.maxUsd < 0))
      throw new Error("INVALID_BUDGET");
    const maxNanos = policy
      ? integer(Math.round(policy.maxUsd * LIMITS.nanosPerUsd), Number.MAX_SAFE_INTEGER, "BUDGET")
      : undefined;
    const cost = await ctx.runQuery(component.reads.cost, args);
    return {
      allowed: cost.unknown === 0 && (maxNanos === undefined || cost.totalNanos < maxNanos),
      ...cost,
      maxNanos: maxNanos ?? null,
    };
  }

  return {
    scope,
    /** Bind core's server-derived attribution to the existing component API.
     * Core already hashes charge AND lifecycle operation keys. Passing them
     * through unchanged keeps saved model steps and tool replays on the same
     * idempotent charge/operation receipts; another usage handler would bill
     * the same saved step a second time under a different identity. */
    usageSlot(): UsageSlot {
      return { scope };
    },
    /** Use the same run-scoped aggregate check as the standalone API. A slot
     * policy overrides only the cap, leaving recording and read policy intact.
     * Fail closed: estimates count, unknown costs deny even without a cap, and
     * authorization/read/policy errors propagate to core, which ends the slice
     * with BUDGET_EXCEEDED rather than admitting potentially unbounded spend.
     * This remains a snapshot check, not a reservation for concurrent work. */
    budgetSlot(policy: MeterOptions["budgets"] = options.budgets): BudgetSlot {
      return {
        check: async (ctx, args) => ({ allowed: (await check(ctx, args, policy)).allowed }),
      };
    },
    threadCost: async (
      ctx: ReadCtx,
      args: { threadId: string; cursors?: Partial<Record<"agent" | "model" | "provider", string>> },
    ) => {
      await authorize(ctx, { threadId: args.threadId });
      for (const axis of ["model", "provider"] as const)
        if (args.cursors?.[axis] !== undefined) requireBreakdown(breakdowns, `thread.${axis}`);
      return await ctx.runQuery(component.reads.threadCost, {
        ...args,
        breakdowns,
        maxGroups: limits.maxGroups,
      });
    },
    subjectCost: async (ctx: ReadCtx, args: { subject: string; runId?: string }) => {
      await authorize(ctx, args);
      return await ctx.runQuery(component.reads.cost, args);
    },
    breakdown: async (
      ctx: ReadCtx,
      args: {
        subject: string;
        from: number;
        to: number;
        by: "day" | "agent" | "model" | "provider";
        cursor?: string;
      },
    ) => {
      await authorize(ctx, { subject: args.subject });
      if (args.by !== "day") requireBreakdown(breakdowns, `subject.${args.by}`);
      return await ctx.runQuery(component.reads.breakdown, {
        ...args,
        breakdowns,
        maxGroups: limits.maxGroups,
        maxDays: limits.maxDays,
      });
    },
    check: (ctx: ReadCtx, args: { subject: string; runId?: string }) => check(ctx, args),
    /**
     * Retention for host crons (server-only; never expose it to clients).
     * Deletes up to `limit` (default 100, max 500) settled charges whose sinks
     * all acknowledged, created before `before`, and their aggregate entries.
     * It also stops at its transaction budget; call again while `more`. Choose
     * `before` past any replay window: a pruned key recorded again is new.
     */
    prune: async (
      ctx: WriteCtx,
      args: { before: number; limit?: number },
    ): Promise<{ deleted: number; more: boolean }> =>
      await ctx.runMutation(component.charges.prune, {
        ...args,
        minAgeMs: limits.pruneMinAgeMs,
      }),
    retrySinks: async (ctx: WriteCtx, args: { key: string; subject: string }) => {
      await authorize(ctx, { subject: args.subject });
      const row = await ctx.runQuery(component.charges.get, { key: args.key });
      if (row?.attribution.subject !== args.subject) throw new Error("CHARGE_NOT_FOUND");
      return await ctx.runMutation(component.charges.retrySinks, {
        key: args.key,
        jobs: await jobs(),
      });
    },
    /** Export these two INTERNAL actions from the host module named in workers. */
    internalFunctions() {
      return {
        meterLookup: internalActionGeneric({
          args: lookupJob,
          returns: v.null(),
          handler: async (ctx, args) => {
            const row = await ctx.runQuery(component.charges.get, { key: args.key });
            if (
              !row ||
              row.lookupUntil !== args.until ||
              row.lookupAttempt !== args.attempt ||
              row.source !== "estimate" ||
              row.status === "unknown"
            )
              return null;
            let amount: ReturnType<typeof costNanos> | undefined;
            if (Date.now() < args.until) {
              try {
                const cost = await providerFor(args.provider).lookup?.(ctx, args.requestId);
                if (cost) amount = costNanos(providerFor(args.provider), cost);
              } catch {
                /* Read-only billing evidence may be retried; paid work never is. */
              }
            }
            await ctx.runMutation(component.charges.lookupResult, {
              ...args,
              ...amount,
            });
            return null;
          },
        }),
        meterDeliver: internalActionGeneric({
          args: deliveryJob,
          returns: v.null(),
          handler: async (ctx, args) => {
            // One job, one batch: <=LIMITS.sinkBatch due events of this sink in
            // a single deliver() call, i.e. one Polar ingest request.
            const events = await ctx.runMutation(component.charges.claimDeliveries, args);
            if (!events.length) return null;
            const sink = sinks.find((s) => s.name === args.sink);
            let ok = false;
            let rateLimited = false;
            let retryAfterMs: number | undefined;
            try {
              if (!sink) throw new Error("SINK_NOT_REGISTERED");
              await sink.deliver(events);
              ok = true;
            } catch (error) {
              if (error instanceof SinkDeliveryError) {
                retryAfterMs = error.retryAfterMs;
                rateLimited = error.rateLimited;
              }
            }
            // Acknowledgements rewrite charge rows, so record the batch's one
            // outcome in chunks that keep each mutation within its budget.
            for (let offset = 0; offset < events.length; offset += LIMITS.ackBatch)
              await ctx.runMutation(component.charges.deliveryResult, {
                sink: args.sink,
                claim: args.claim,
                keys: events.slice(offset, offset + LIMITS.ackBatch).map((event) => event.key),
                ok,
                rateLimited,
                jobs: args.jobs,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
              });
            return null;
          },
        }),
      };
    },
  };
}

export type Meter = ReturnType<typeof defineMeter>;
/** Agent pages are always present; model/provider pages are optional opt-ins. */
export type ThreadCost = Awaited<ReturnType<Meter["threadCost"]>>;
