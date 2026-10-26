/**
 * Host internal actions invoked by the component Workpool.
 * Lookup workers fence billing-evidence requests against the stored attempt;
 * delivery workers send one bounded outbox batch then acknowledge in chunks.
 * Read-only lookup evidence can retry, while paid provider work is never run here.
 */
import { internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import { deliveryJob, lookupJob } from "../shared/contracts.js";
import { LIMITS } from "../shared/limits.js";
import { providerFor, type MeterContext } from "./configuration.js";
import { costNanos } from "./pricing.js";
import { SinkDeliveryError } from "./sinks.js";

/** Build the fenced lookup action; stale or expired jobs cannot start new provider work. */
function lookupWorker(meter: MeterContext) {
  const { component } = meter;

  return internalActionGeneric({
    args: lookupJob,
    returns: v.null(),
    handler: async (ctx, args) => {
      const row = await ctx.runQuery(component.charges.get, { key: args.key });

      if (
        !row ||
        row.provider !== args.provider ||
        row.providerRequestId !== args.requestId ||
        row.lookupUntil !== args.until ||
        row.lookupAttempt !== args.attempt ||
        row.reconciliation !== "running"
      )
        return null;

      let amount: ReturnType<typeof costNanos> | undefined;

      if (Date.now() < args.until) {
        try {
          const cost = await providerFor(meter, args.provider).lookup?.(ctx, args.requestId);

          if (cost) amount = costNanos(providerFor(meter, args.provider), cost);
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
  });
}

/** Build one-batch delivery with chunked acknowledgements under the mutation byte bound. */
function deliveryWorker(meter: MeterContext) {
  const { component, sinks } = meter;

  return internalActionGeneric({
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
  });
}

/** Export these two INTERNAL actions from the host module named in workers. */
export function internalFunctions(meter: MeterContext) {
  return { meterLookup: lookupWorker(meter), meterDeliver: deliveryWorker(meter) };
}
