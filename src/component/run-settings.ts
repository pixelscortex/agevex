// Resolved per-agent run policy. Runs snapshot this array at acceptance; children
// share the root run id, so no descendant copies or registration lookups occur.
import { getConvexSize, v, type Infer } from "convex/values";
import { HOST_LIMITS, LIMITS, PLATFORM } from "./limits.js";

/** Per-step defaults and hard ceilings; the combined deadline is checked too. */
export const RUN_LIMITS = {
  maxOutputTokens: { default: 4_096, min: 1, max: 32_768 },
  modelTimeoutMs: { default: 90_000, min: 1_000, max: 300_000 },
  toolTimeoutMs: { default: 90_000, min: 1_000, max: 300_000 },
  stepsPerTurn: { default: 16, min: 1, max: 64 },
  toolsPerSlice: 16,
  persistenceMs: 30_000,
  sliceDeadlineMs: 300_000,
  watchdogMarginMs: 30_000,
  metadataBytes: 16 << 10,
  // Native id/time envelope plus growth of bounded counters and JSON masks.
  nativeEnvelopeBytes: 256,
  // Root backlog + reserved head/answer/current, plus one budget per child.
  cancelBudgets: HOST_LIMITS.queueLength.max + HOST_LIMITS.activeChildrenPerRoot.max + 3,
  // Reserve 1 KiB for ids, model overrides, counters and the native envelope.
  settingsBytes: 15 << 10,
} as const;

/** Public options on Agent.run; validation happens at registration. */
export type RunSettings = Partial<ResolvedRunSettings>;

/** Policy returned by claim and consumed by generation and its watchdog. */
export const runSettings = v.object({
  askUser: v.optional(v.boolean()),
  mode: v.union(v.literal("stream"), v.literal("generate")),
  maxOutputTokens: v.number(),
  modelTimeoutMs: v.number(),
  toolTimeoutMs: v.number(),
  stepsPerTurn: v.number(),
});

/** Fully resolved policy, independent of subsequent registration changes. */
export type ResolvedRunSettings = Infer<typeof runSettings>;

/** Bounded name-to-policy snapshot stored only on the existing root runs row. */
export const settingsSnapshot = v.array(v.object({ agent: v.string(), settings: runSettings }));
export type SettingsSnapshot = Infer<typeof settingsSnapshot>;

/** Validate before any work is accepted, including the platform action ceiling. */
export function resolveRunSettings(input: RunSettings = {}): ResolvedRunSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("INVALID_RUN_SETTINGS");

  const result: ResolvedRunSettings = {
    ...(input.askUser !== undefined ? { askUser: input.askUser } : {}),
    mode: input.mode === undefined ? "stream" : input.mode,
    maxOutputTokens:
      input.maxOutputTokens === undefined
        ? RUN_LIMITS.maxOutputTokens.default
        : input.maxOutputTokens,
    modelTimeoutMs:
      input.modelTimeoutMs === undefined ? RUN_LIMITS.modelTimeoutMs.default : input.modelTimeoutMs,
    toolTimeoutMs:
      input.toolTimeoutMs === undefined ? RUN_LIMITS.toolTimeoutMs.default : input.toolTimeoutMs,
    stepsPerTurn:
      input.stepsPerTurn === undefined ? RUN_LIMITS.stepsPerTurn.default : input.stepsPerTurn,
  };

  if (input.askUser !== undefined && typeof input.askUser !== "boolean")
    throw new Error("INVALID_ASK_USER_POLICY");

  if (result.mode !== "stream" && result.mode !== "generate")
    throw new Error("INVALID_RUN_SETTINGS");

  for (const key of [
    "maxOutputTokens",
    "modelTimeoutMs",
    "toolTimeoutMs",
    "stepsPerTurn",
  ] as const) {
    const value = result[key];
    const bound = RUN_LIMITS[key];

    if (!Number.isSafeInteger(value) || value < bound.min || value > bound.max)
      throw new Error("INVALID_RUN_SETTINGS");
  }

  if (
    result.modelTimeoutMs +
      RUN_LIMITS.toolsPerSlice * result.toolTimeoutMs +
      RUN_LIMITS.persistenceMs +
      RUN_LIMITS.watchdogMarginMs >
    PLATFORM.convexActionMs
  )
    throw new Error("RUN_DEADLINE_EXCEEDS_ACTION_LIMIT");

  return result;
}

/** Bound a slice even when many slow tools are allowed. Phase deadlines still
 * apply independently; the five-minute cap prevents a default 26-minute wait. */
export function sliceDeadlineMs(settings: ResolvedRunSettings): number {
  return Math.min(
    RUN_LIMITS.sliceDeadlineMs,
    settings.modelTimeoutMs +
      RUN_LIMITS.toolsPerSlice * settings.toolTimeoutMs +
      RUN_LIMITS.persistenceMs,
  );
}

/** The server waits beyond the client fence so timeout finalization can commit. */
export function sliceWatchdogMs(settings: ResolvedRunSettings): number {
  return sliceDeadlineMs(settings) + RUN_LIMITS.watchdogMarginMs;
}

/** Bound both Convex and JSON bytes, including multi-byte names and escaping. */
export function assertSettingsSnapshot(settings: SettingsSnapshot): void {
  if (
    settings.length > LIMITS.agents ||
    getConvexSize(settings) > RUN_LIMITS.settingsBytes ||
    new TextEncoder().encode(JSON.stringify(settings)).byteLength > RUN_LIMITS.settingsBytes
  )
    throw new Error("RUN_SETTINGS_TOO_LARGE");

  for (const value of settings) resolveRunSettings(value.settings);
}
