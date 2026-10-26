/**
 * Indexed, on-demand discovery of saved request ids. Each batch leaves the
 * pending index before scheduling its successor, so the chain ends when empty.
 * This only schedules billing-evidence reads; it cannot invoke a model.
 */
import { v, type Infer } from "convex/values";
import type { MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { jobs } from "../shared/contracts.js";
import { LIMITS, integer, text } from "../shared/limits.js";
import { validateJobs } from "./jobs.js";
import { startLookup } from "./charge_lookup.js";

export const reconcileArgs = {
  subject: v.string(),
  runId: v.string(),
  providers: v.array(v.object({ name: v.string(), lookupMs: v.number() })),
  jobs,
};

/** Four full charges <=4*280 KiB, four patches and Workpool admissions <8 MiB.
 * Four charge index reads plus bounded Workpool admissions, independent of
 * root charge count; no transcript IO. */
export async function reconcileRun(
  ctx: MutationCtx,
  args: Infer<ReturnType<typeof v.object<typeof reconcileArgs>>>,
) {
  text(args.subject, "SUBJECT");
  text(args.runId, "RUN");
  validateJobs(args.jobs);

  if (args.providers.length > LIMITS.maxProviders) throw new Error("INVALID_PROVIDERS");

  for (const provider of args.providers) {
    text(provider.name, "PROVIDER");
    integer(provider.lookupMs, LIMITS.maxLookupMs, "LOOKUP_WINDOW");

    if (!provider.lookupMs) throw new Error("INVALID_LOOKUP_WINDOW");
  }

  for (let index = 0; index < LIMITS.reconcileBatch; index++) {
    const row = await ctx.db
      .query("charges")
      .withIndex("by_run_lookup", (q) =>
        q
          .eq("attribution.subject", args.subject)
          .eq("attribution.runId", args.runId)
          .eq("reconciliation", "pending"),
      )
      .first();

    if (!row) return null;

    const provider = args.providers.find((provider) => provider.name === row.provider);

    await startLookup(ctx, row, row.providerRequestId!, provider?.lookupMs ?? LIMITS.lookupMs, {
      ...args.jobs,
      ...(!provider ? { lookup: undefined } : {}),
    });
  }

  await ctx.scheduler.runAfter(0, internal.charges.reconcileRun, args);

  return null;
}
