/** Fixed hard ceilings: hosts cannot accidentally turn telemetry into an unbounded log. */
export const LIMITS = {
  maxSpansPerTurn: 128,
  maxAttributeBytes: 16_384,
  maxValueBytes: 4096,
  maxNameBytes: 256,
  // Seven propagated facts × 256 bytes × worst-case JSON escaping (6)
  // plus key/OTLP overhead fits under 12 KiB, leaving room in each 16 KiB list.
  maxFactBytes: 256,
  maxConfigurationBytes: 4096,
  maxExporters: 4,
  maxValueNodes: 128,
  maxValueDepth: 8,
  exportTimeoutMs: 3000,
  traceIdHexLength: 32,
  spanIdHexLength: 16,
  nanosPerMillisecond: 1_000_000,
} as const;

export const TRUNCATED = "[truncated]";
const encoder = new TextEncoder();
export const bytes = (value: string) => encoder.encode(value).byteLength;

/** Iterate only the retained prefix, without allocating an encoding of a huge input. */
export function truncate(value: string, maximum: number): string {
  let size = 0;
  let prefix = "";
  const available = maximum - bytes(TRUNCATED);
  for (const character of value) {
    size += bytes(character);
    if (size > available) {
      // Small values may fit without reserving room for the marker.
      if (value.length <= maximum && bytes(value) <= maximum) return value;
      return prefix + TRUNCATED;
    }
    prefix += character;
  }
  return prefix;
}

export function validateString(value: string, name: string, maximum: number): void {
  if (typeof value !== "string" || !value || value.length > maximum || bytes(value) > maximum)
    throw new Error(`Invalid telemetry ${name}`);
}

/**
 * Copy a bounded tree before invoking user sanitization or JSON.stringify. In particular,
 * never stringify a raw tool result: it can contain cycles, megabytes or custom toJSON.
 * Traversal visits at most 128 nodes, eight levels and 4096 bytes per string/key.
 */
export function boundedValue(value: unknown): unknown {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > LIMITS.maxValueNodes || depth > LIMITS.maxValueDepth) return TRUNCATED;
    if (typeof item === "string") return truncate(item, LIMITS.maxValueBytes);
    if (typeof item === "number") return Number.isFinite(item) ? item : undefined;
    if (typeof item === "boolean" || item === null) return item;
    if (typeof item !== "object") return undefined;
    if (seen.has(item)) return TRUNCATED;
    seen.add(item);
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (const entry of item) {
        if (nodes >= LIMITS.maxValueNodes) {
          result.push(TRUNCATED);
          break;
        }
        result.push(visit(entry, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      if (nodes >= LIMITS.maxValueNodes) {
        result[TRUNCATED] = true;
        break;
      }
      result[truncate(key, LIMITS.maxValueBytes)] = visit(
        (item as Record<string, unknown>)[key],
        depth + 1,
      );
    }
    return result;
  };
  return visit(value, 0);
}
