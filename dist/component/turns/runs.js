import { getConvexSize } from "convex/values";
import { assertSettingsSnapshot, RUN_LIMITS } from "../run-settings.js";
/** The fresh budget for one accepted send. `models` is the thread's model
 * policy at acceptance, snapshotted so later sends cannot change a live run. */
export function newRun(models, settings = []) {
    assertSettingsSnapshot(settings);
    const row = {
        settings,
        models,
        // 64-bit agent-index masks: who started in this run / who owns routing.
        startedAgents: 0n,
        routingAgents: 0n,
        // Spend counters, each checked against its limits.ts bound.
        continues: 0,
        sideRuns: 0,
        launches: 0,
        hops: 0,
        cancelled: false,
        usagePartial: false,
    };
    // The 1 KiB reservation includes the native id/time envelope added on insert.
    if (Math.max(getConvexSize(row), new TextEncoder().encode(JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value)).byteLength) +
        RUN_LIMITS.nativeEnvelopeBytes >
        RUN_LIMITS.metadataBytes)
        throw new Error("RUN_METADATA_TOO_LARGE");
    return row;
}
