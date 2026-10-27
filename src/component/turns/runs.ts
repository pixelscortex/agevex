/**
 * Row builder for the `runs` table.
 *
 * A run is one accepted user request and all the work it causes: every turn,
 * delegated child and delivered result spends from the same
 * launch/hop counters. `turns.send.accept` creates one per send;
 * descendants inherit its id. Claim reads the per-agent model choice fixed
 * here, and cancel marks the run cancelled for every assignment under it.
 */
import type { WithoutSystemFields } from "convex/server";
import { valueBytes } from "../../shared/json.js";
import { assertSettingsSnapshot, RUN_LIMITS } from "../run_settings.js";
import type { Doc } from "../_generated/dataModel.js";

/** The fresh budget for one accepted send. `models` is the thread's model
 * policy at acceptance, snapshotted so later sends cannot change a live run. */
export function newRun(
  models: Doc<"runs">["models"],
  settings: Doc<"runs">["settings"] = [],
  metadata: Pick<Doc<"runs">, "rootAssignmentId" | "rootCancellationEpoch" | "taskMessageId"> = {},
): WithoutSystemFields<Doc<"runs">> {
  assertSettingsSnapshot(settings);

  const row = {
    ...metadata,
    settings,
    models,
    // Spend counters, each checked against its limits.ts bound.
    launches: 0,
    hops: 0,
    cancelled: false,
    usagePartial: false,
  };

  // Reserve 1 KiB for native id/time, lifecycle fields and bounded counter
  // growth. Both JSON UTF-8 and Convex bytes must stay <=16 KiB after updates.
  if (valueBytes(row) + RUN_LIMITS.nativeEnvelopeBytes > RUN_LIMITS.metadataBytes)
    throw new Error("RUN_METADATA_TOO_LARGE");

  return row;
}
