/**
 * Attribution-bound charge writers for standalone host calls and core slots.
 * One binding caches attribution lazily while each operation still runs its guard.
 * Trusted slots validate server-derived labels without invoking identity-based
 * host authorization; standalone scope calls retain that authorization step.
 */
import type { MeterContext } from "./configuration.js";
import { authorize, jobs, registered } from "./configuration.js";
import { LIMITS, integer, text } from "../shared/limits.js";
import { priceEstimate, priceInline } from "./pricing.js";
import { chargeHandle } from "./handles.js";
import type { Attribution, ScopedMeter, WriteCtx } from "./types.js";

export type MeterBinding = {
  meter: MeterContext;
  ctx: WriteCtx;
  guard: () => Promise<Attribution>;
};

/** Cache attribution, preserving per-call authorization and the trusted core boundary. */
function binding(
  meter: MeterContext,
  ctx: WriteCtx,
  attributed: () => Promise<Attribution>,
  trusted: boolean,
): MeterBinding {
  let cached: Attribution | undefined;
  const facts = async () => (cached ??= await attributed());

  const guard = async () => {
    const attribution = await facts();

    if (trusted) {
      for (const value of Object.values(attribution))
        if (value !== undefined) text(value, "ATTRIBUTION");
    } else await authorize(meter, ctx, attribution);

    return attribution;
  };

  return { meter, ctx, guard };
}

/**
 * Host calls (`scope`) run the host `authorize` guard. Core's slot calls
 * (`trusted`) do not: their attribution is server-derived, core authorized
 * the turn when it began, and they run in background actions with no user
 * identity, where an identity-based guard would drop every charge.
 */
export function bind(
  meter: MeterContext,
  ctx: WriteCtx,
  attributed: () => Promise<Attribution>,
  trusted: boolean,
  resolve: (name: string) => string = (name) => name,
): ScopedMeter {
  const bound = binding(meter, ctx, attributed, trusted);
  const { guard } = bound;
  const { component, breakdowns, sinks, limits } = meter;

  return {
    // Malformed keys, names and quantities are caller bugs and still throw;
    // unpriceable amounts and unregistered names are recorded `unknown`.
    estimate: async (requested, args) => {
      const attribution = await guard();
      const name = resolve(requested);
      const provider = registered(meter, name);

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
        jobs: await jobs(meter),
      });

      return chargeHandle(bound, args.key, provider);
    },
    record: async (requested, args) => {
      const attribution = await guard();
      const name = resolve(requested);
      const provider = registered(meter, name);

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
        jobs: await jobs(meter),
      });

      return chargeHandle(bound, args.key, provider);
    },
  };
}

/** Bind explicit host attribution; the subject guard remains eager, all other checks lazy. */
export function scope(meter: MeterContext, ctx: WriteCtx, attribution: Attribution): ScopedMeter {
  text(attribution.subject, "SUBJECT");

  return bind(meter, ctx, async () => attribution, false);
}
