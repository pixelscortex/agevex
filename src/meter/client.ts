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
  WriteCtx,
} from "./types.js";
import { openRouterCost } from "./helpers.js";
import { SinkDeliveryError } from "./sinks.js";

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
function costNanos(provider: Provider, cost: Cost) {
  if ("usd" in cost && "credits" in cost) throw new Error("AMBIGUOUS_COST");
  if ("usd" in cost) return { nanos: nanos(cost.usd) };
  integer(cost.credits, LIMITS.maxQuantity, "CREDITS");
  if (!provider.credits) throw new Error("CREDIT_RATE_REQUIRED");
  return { nanos: nanos(cost.credits * provider.credits.usdPerCredit), credits: cost.credits };
}

export function defineMeter(component: ComponentApi, options: MeterOptions) {
  const limits = resolveLimits(options.limits);
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

  function providerFor(name: string) {
    text(name, "PROVIDER");
    const provider = Object.prototype.hasOwnProperty.call(options.providers, name)
      ? options.providers[name]
      : undefined;
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
    function handle(key: string, name: string): ChargeHandle {
      const provider = providerFor(name);
      return {
        key,
        get: async () => {
          await authorize(ctx, attribution);
          return await ctx.runQuery(component.charges.get, { key });
        },
        attach: async ({ requestId }) => {
          await authorize(ctx, attribution);
          return await ctx.runMutation(component.charges.attach, {
            key,
            requestId,
            lookupMs: lookupMs(provider),
            jobs: { ...(await jobs()), ...(!provider.lookup ? { lookup: undefined } : {}) },
          });
        },
        correct: async ({ quantity }) => {
          await authorize(ctx, attribution);
          integer(quantity, LIMITS.maxQuantity, "QUANTITY");
          const row = await ctx.runQuery(component.charges.get, { key });
          const price = row?.profile && provider.profiles?.[row.profile];
          if (!price) throw new Error("PROFILE_REQUIRED");
          return await ctx.runMutation(component.charges.update, {
            key,
            operation: "correct",
            quantity,
            nanos: nanos(price.usd * quantity),
            jobs: await jobs(),
          });
        },
        settle: async (cost) => {
          await authorize(ctx, attribution);
          return await ctx.runMutation(component.charges.update, {
            key,
            operation: "settle",
            ...costNanos(provider, cost),
            jobs: await jobs(),
          });
        },
      };
    }
    return {
      estimate: async (name, args) => {
        await authorize(ctx, attribution);
        const provider = providerFor(name);
        text(args.key, "KEY", LIMITS.maxKeyBytes);
        integer(args.quantity, LIMITS.maxQuantity, "QUANTITY");
        const price = args.profile && provider.profiles?.[args.profile];
        if (args.profile && !price) throw new Error("PROFILE_NOT_REGISTERED");
        await ctx.runMutation(component.charges.create, {
          key: args.key,
          attribution,
          provider: name,
          ...(args.profile ? { profile: args.profile } : {}),
          quantity: args.quantity,
          status: "estimate",
          source: "estimate",
          ...(price ? { nanos: nanos(price.usd * args.quantity) } : {}),
          sinks: sinks.map((s) => s.name),
          maxCharges: limits.maxCharges,
          jobs: await jobs(),
        });
        return handle(args.key, name);
      },
      record: async (name, args) => {
        await authorize(ctx, attribution);
        const provider = providerFor(name);
        text(args.key, "KEY", LIMITS.maxKeyBytes);
        const cost = provider.inline?.({
          usage: args.usage,
          providerMetadata: args.providerMetadata,
        });
        await ctx.runMutation(component.charges.create, {
          key: args.key,
          attribution,
          provider: name,
          status: cost ? "settled" : "unknown",
          source: "inline",
          ...(cost ? costNanos(provider, cost) : {}),
          sinks: sinks.map((s) => s.name),
          maxCharges: limits.maxCharges,
          jobs: await jobs(),
        });
        return handle(args.key, name);
      },
    };
  }

  return {
    scope,
    threadCost: async (ctx: ReadCtx, args: { threadId: string }) => {
      await authorize(ctx, args);
      return await ctx.runQuery(component.reads.threadCost, args);
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
      return await ctx.runQuery(component.reads.breakdown, {
        ...args,
        maxGroups: limits.maxGroups,
        maxDays: limits.maxDays,
      });
    },
    check: async (ctx: ReadCtx, args: { subject: string; runId?: string }) => {
      await authorize(ctx, args);
      const policy = await options.budgets?.(args);
      // Budget caps can cover many charges; allow the mount's exact maximum,
      // rather than reusing the smaller per-charge dollar conversion ceiling.
      if (policy && (!Number.isFinite(policy.maxUsd) || policy.maxUsd < 0))
        throw new Error("INVALID_BUDGET");
      const maxNanos = policy
        ? integer(
            Math.round(policy.maxUsd * LIMITS.nanosPerUsd),
            LIMITS.maxCharges * LIMITS.maxChargeNanos,
            "BUDGET",
          )
        : undefined;
      const cost = await ctx.runQuery(component.reads.cost, args);
      return {
        allowed: cost.unknown === 0 && (maxNanos === undefined || cost.totalNanos < maxNanos),
        ...cost,
        maxNanos: maxNanos ?? null,
      };
    },
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
            const row = await ctx.runQuery(component.charges.get, { key: args.key });
            const state = row?.sinkState.find((s) => s.name === args.sink);
            if (!row || state?.pending?.externalId !== args.event.externalId) return null;
            const sink = sinks.find((s) => s.name === args.sink);
            let ok = false;
            let retryAfterMs: number | undefined;
            try {
              if (!sink) throw new Error("SINK_NOT_REGISTERED");
              await sink.deliver([
                {
                  ...args.event,
                  key: row.key,
                  attribution: row.attribution,
                  provider: row.provider,
                },
              ]);
              ok = true;
            } catch (error) {
              if (error instanceof SinkDeliveryError) retryAfterMs = error.retryAfterMs;
            }
            await ctx.runMutation(component.charges.deliveryResult, {
              ...args,
              ok,
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
