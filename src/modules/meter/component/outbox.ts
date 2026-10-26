/**
 * Charge-to-sink outbox preparation inside charge lifecycle transactions.
 * Pending event snapshots stay immutable until acknowledged, including when
 * a delivery outcome is uncertain. Each pending charge/sink pair has exactly
 * one small deliveries row; Workpool jobs read those rows instead of charges.
 */
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { LIMITS } from "../shared/limits.js";
import { billable, isTerminal } from "./charge_records.js";
import { enqueueDrain, type Jobs } from "./jobs.js";

/** Build one small outbox row at admission; event identity is frozen until acknowledgement. */
function newDelivery(
  row: Doc<"charges">,
  sink: string,
  event: NonNullable<Doc<"charges">["sinkState"][number]["pending"]>,
) {
  return {
    // The event snapshot stays paired with the charge/sink identity until acknowledged.
    sink,
    key: row.key,
    event,
    attribution: row.attribution,
    provider: row.provider,
    // A new event starts due and unclaimed; jobs own all subsequent retry state.
    attempts: 0,
    limited: false,
    failed: false,
    dueAt: Date.now(),
  };
}

/**
 * Whether this sink already holds the charge's current state. A classification
 * change at an unchanged amount is a $0 revision that only sinks which opted
 * into estimates want; others (e.g. Polar) would receive meaningless $0 events.
 */
function delivered(row: Doc<"charges">, sink: Doc<"charges">["sinkState"][number]) {
  return (
    sink.deliveredNanos === row.nanos &&
    (!sink.estimates ||
      (sink.deliveredStatus === row.status && sink.deliveredSource === row.source))
  );
}

/** Outbox snapshots are immutable until acknowledged, including on uncertain
 * delivery. A pending event exists on the charge exactly while its outbox row
 * exists; the row is the copy delivery jobs read. */
export async function prepareSinks(
  ctx: MutationCtx,
  row: Doc<"charges">,
  config: Jobs,
  changed = false,
) {
  const sinkState = row.sinkState.map((sink) => ({ ...sink }));
  const due: string[] = [];

  if (row.nanos !== undefined)
    for (const sink of sinkState) {
      if (!billable(row, sink.estimates) || sink.pending || delivered(row, sink)) continue;

      sink.revision++;

      sink.pending = {
        externalId:
          sink.deliveredNanos === undefined
            ? row.key
            : `${row.key}${LIMITS.deltaSeparator}${sink.revision}`,
        revision: sink.revision,
        nanos: row.nanos - (sink.deliveredNanos ?? 0),
        totalNanos: row.nanos,
        // Freeze classification alongside amount: delivery never consults the charge.
        status: row.status,
        source: row.source,
      };

      await ctx.db.insert("deliveries", newDelivery(row, sink.name, sink.pending));

      due.push(sink.name);
    }

  const next = { ...row, sinkState };
  const terminal = isTerminal(next);

  if (changed || due.length || terminal !== row.terminal)
    await ctx.db.patch("charges", row._id, { sinkState, terminal });

  for (const sink of due)
    await enqueueDrain(ctx, sink, config, Date.now() + LIMITS.deliveryWindowMs);

  return { ...next, terminal };
}
