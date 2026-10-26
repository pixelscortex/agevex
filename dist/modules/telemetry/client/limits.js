/**
 * Hard ceilings and defensive value traversal for host telemetry.
 * Attribute writers and attribution validation share these UTF-8 limits.
 * Bounded copies protect sanitizers and JSON encoding from huge or cyclic inputs.
 */
/** Fixed hard ceilings: hosts cannot accidentally turn telemetry into an unbounded log. */
export const LIMITS = {
    maxSpansPerTurn: 128,
    maxAttributeBytes: 16_384,
    maxValueBytes: 4096,
    maxNameBytes: 256,
    // Seven propagated facts × 256 bytes × worst-case JSON escaping (6)
    // plus key/OTLP overhead fits under 12 KiB, leaving room in each 16 KiB list.
    // A fact above this is not rejected (that would silently disable telemetry for
    // the whole turn): it is exported as "sha256:" + a 64-hex digest instead, 71 bytes.
    maxFactBytes: 256,
    factDigestHexLength: 64,
    maxConfigurationBytes: 4096,
    maxExporters: 4,
    maxValueNodes: 128,
    maxValueDepth: 8,
    exportTimeoutMs: 3000,
    traceIdHexLength: 32,
    spanIdHexLength: 16,
    nanosPerMillisecond: 1_000_000,
};
export const TRUNCATED = "[truncated]";
const encoder = new TextEncoder();
/** Measure encoded UTF-8 bytes wherever character counts cannot enforce export bounds. */
export const bytes = (value) => encoder.encode(value).byteLength;
/** Iterate only the retained prefix, without allocating an encoding of a huge input. */
export function truncate(value, maximum) {
    let size = 0;
    let prefix = "";
    const available = maximum - bytes(TRUNCATED);
    for (const character of value) {
        size += bytes(character);
        if (size > available) {
            // Small values may fit without reserving room for the marker.
            if (value.length <= maximum && bytes(value) <= maximum)
                return value;
            return prefix + TRUNCATED;
        }
        prefix += character;
    }
    return prefix;
}
/** Reject invalid registration/fact strings before the observer retains any state. */
export function validateString(value, name, maximum) {
    if (typeof value !== "string" || !value || value.length > maximum || bytes(value) > maximum)
        throw new Error(`Invalid telemetry ${name}`);
}
/**
 * Copy a bounded tree before invoking user sanitization or JSON.stringify. In particular,
 * never stringify a raw tool result: it can contain cycles, megabytes or custom toJSON.
 * Traversal visits at most 128 nodes, eight levels and 4096 bytes per string/key.
 */
export function boundedValue(value) {
    let nodes = 0;
    const seen = new WeakSet();
    const visit = (item, depth) => {
        if (++nodes > LIMITS.maxValueNodes || depth > LIMITS.maxValueDepth)
            return TRUNCATED;
        if (typeof item === "string")
            return truncate(item, LIMITS.maxValueBytes);
        if (typeof item === "number")
            return Number.isFinite(item) ? item : undefined;
        if (typeof item === "boolean" || item === null)
            return item;
        if (typeof item !== "object")
            return undefined;
        if (seen.has(item))
            return TRUNCATED;
        seen.add(item);
        if (Array.isArray(item)) {
            const result = [];
            for (const entry of item) {
                if (nodes >= LIMITS.maxValueNodes) {
                    result.push(TRUNCATED);
                    break;
                }
                result.push(visit(entry, depth + 1));
            }
            return result;
        }
        const result = Object.create(null);
        for (const key in item) {
            if (!Object.prototype.hasOwnProperty.call(item, key))
                continue;
            if (nodes >= LIMITS.maxValueNodes) {
                result[TRUNCATED] = true;
                break;
            }
            result[truncate(key, LIMITS.maxValueBytes)] = visit(item[key], depth + 1);
        }
        return result;
    };
    return visit(value, 0);
}
