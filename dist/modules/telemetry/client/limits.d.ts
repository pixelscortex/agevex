/**
 * Hard ceilings and defensive value traversal for host telemetry.
 * Attribute writers and attribution validation share these UTF-8 limits.
 * Bounded copies protect sanitizers and JSON encoding from huge or cyclic inputs.
 */
/** Fixed hard ceilings: hosts cannot accidentally turn telemetry into an unbounded log. */
export declare const LIMITS: {
    readonly maxSpansPerTurn: 128;
    readonly maxAttributeBytes: 16384;
    readonly maxValueBytes: 4096;
    readonly maxNameBytes: 256;
    readonly maxFactBytes: 256;
    readonly factDigestHexLength: 64;
    readonly maxConfigurationBytes: 4096;
    readonly maxExporters: 4;
    readonly maxValueNodes: 128;
    readonly maxValueDepth: 8;
    readonly exportTimeoutMs: 3000;
    readonly traceIdHexLength: 32;
    readonly spanIdHexLength: 16;
    readonly nanosPerMillisecond: 1000000;
};
export declare const TRUNCATED = "[truncated]";
/** Measure encoded UTF-8 bytes wherever character counts cannot enforce export bounds. */
export declare const bytes: (value: string) => number;
/** Iterate only the retained prefix, without allocating an encoding of a huge input. */
export declare function truncate(value: string, maximum: number): string;
/** Reject invalid registration/fact strings before the observer retains any state. */
export declare function validateString(value: string, name: string, maximum: number): void;
/**
 * Copy a bounded tree before invoking user sanitization or JSON.stringify. In particular,
 * never stringify a raw tool result: it can contain cycles, megabytes or custom toJSON.
 * Traversal visits at most 128 nodes, eight levels and 4096 bytes per string/key.
 */
export declare function boundedValue(value: unknown): unknown;
