/**
 * Resolved host configuration shared explicitly by the meter builders.
 * Registration validates limits, provider profiles and worker requirements.
 * Runtime helpers retain the host authorization boundary and create worker
 * handles on demand; they never access component tables directly.
 */
import { createFunctionHandle } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { resolveBreakdowns, type Breakdown } from "../shared/breakdowns.js";
import { LIMITS, integer, nanos, resolveLimits, text } from "../shared/limits.js";
import { lookupMs } from "./pricing.js";
import type { ResolvedLimits } from "../shared/limits.js";
import type { Attribution, MeterOptions, ReadCtx, Sink } from "./types.js";

export type MeterContext = {
  component: ComponentApi;
  options: MeterOptions;
  limits: ResolvedLimits;
  breakdowns: Breakdown[];
  sinks: (Sink & { name: string })[];
};

/** Resolve registration once, preserving validation order before any host operation. */
export function resolveMeter(component: ComponentApi, options: MeterOptions): MeterContext {
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

  return { component, options, limits, breakdowns, sinks };
}

/** Find only own provider registrations; unknown names must remain billable unknowns. */
export function registered({ options }: MeterContext, name: string) {
  text(name, "PROVIDER");

  return Object.prototype.hasOwnProperty.call(options.providers, name)
    ? options.providers[name]
    : undefined;
}
/** Require a provider for read-only lookup work after its job fence has passed. */
export function providerFor(meter: MeterContext, name: string) {
  const provider = registered(meter, name);

  if (!provider) throw new Error("PROVIDER_NOT_REGISTERED");

  return provider;
}
/** Resolve worker handles per call, keeping lookup before delivery as in registration. */
export async function jobs({ options, limits }: MeterContext) {
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
/** Validate all attribution labels before invoking the host guard on standalone calls. */
export async function authorize(
  { options }: MeterContext,
  ctx: ReadCtx,
  attribution: Partial<Attribution>,
) {
  for (const value of Object.values(attribution))
    if (value !== undefined) text(value, "ATTRIBUTION");

  await options.authorize?.(ctx, attribution);
}
