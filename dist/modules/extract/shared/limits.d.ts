/**
 * Hard ceilings keep provider bodies out of rows and every tool response bounded.
 *
 * Memory arithmetic (why the byte ceilings differ per runtime). A default
 * Convex action has 64 MiB; a "use node" action has 512 MiB. Reserve 16 MiB for
 * code, zod, the AI SDK and runtime overhead, leaving a 48 MiB working set. No
 * garbage-collection timing is assumed: every copy that can be live at once is
 * counted. N is input bytes and P is serialized payload bytes.
 *
 * - Request phase (Firecrawl multipart): storage Blob N + serialized request
 *   body N + fetch/runtime buffer N = 3N. Vision OCR holds Blob N, its
 *   Uint8Array N and about three base64/JSON copies of 4/3 N each = 6N.
 * - Output phase: the Blob stays cached for the checksum and backend, N, plus
 *   response chunks and their merge 2P, decoded string up to 2P (UTF-16),
 *   parsed object up to 2P, = N + 6P. Serializing the result is smaller: text
 *   2P + JSON string 2P + Blob P = 5P. That holds only because `document()`
 *   computes the exact serialized size first and rejects before stringifying:
 *   control characters escape to six characters each and one non-Latin-1
 *   character makes the string two-byte, so an unguarded JSON string of a
 *   4 MiB text would be 6 * 4 MiB * 2 bytes = 48 MiB (12N). Direct text is the
 *   extreme: blob N, arrayBuffer N, decoded string 2N, JSON string 2P, output
 *   Blob P = 4N + 3P.
 * - Reads: Blob P + string 2P + parsed 2P + one UTF-8 window encoding P = 6P.
 *   The hash is computed in streamed chunks, so it adds no whole-file copy.
 *
 * Default runtime: document 12 MiB -> 3N = 36 MiB; image 6 MiB -> 6N = 36 MiB;
 * text 4 MiB -> 4N + 3P = 34 MiB; payload 6 MiB -> N + 6P = 12 + 36 = 48 MiB (the
 * whole working set, hence exactly 64 MiB with the reserve) and reads 36 MiB.
 * Node runtime: document 50 MB -> 3N = 150 MB; image 10 MB -> 6N = 60 MB;
 * text 8 MiB -> 4N + 3P = 128 MiB; payload 32 MiB -> N + 6P = 50 + 192 = 242 MB;
 * reads 192 MiB; all well under 496 MiB. Files above a default ceiling run in
 * the optional Node worker, never in the default one.
 */
export declare const LIMITS: {
    readonly maxBytes: {
        readonly document: number;
        readonly image: number;
        readonly text: number;
    };
    readonly payloadBytes: number;
    readonly node: {
        readonly maxBytes: {
            readonly document: 50000000;
            readonly image: 10000000;
            readonly text: number;
        };
        readonly payloadBytes: number;
    };
    readonly readBytes: number;
    readonly pages: 100;
    readonly totalPages: 10000;
    readonly toolBytes: number;
    readonly summaryBytes: 1024;
    readonly identifierBytes: 256;
    readonly hashBytes: 64;
    readonly urlBytes: 4096;
    readonly queryBytes: 4096;
    readonly optionsBytes: 4096;
    readonly backends: 32;
    /** A started extraction may run this long before its outcome becomes unknown. */
    readonly leaseMs: number;
    /**
     * A queued (pending) extraction has done no paid work. After this long an
     * admission may dispatch it again with a new claim; the old dispatch can no
     * longer start. It never turns a queued job into `unknown`.
     */
    readonly queueMs: number;
    /**
     * Retryable failures (PROVIDER_UNAVAILABLE, OBJECT_UNAVAILABLE,
     * CHECKSUM_FAILED) may be admitted again, each time by an explicit `run`, up
     * to this many attempts in total. This is a hard bound on paid repeats: the
     * module never retries by itself, and the fourth failure is final.
     */
    readonly maxAttempts: 3;
    /**
     * Completion callbacks kept on one artifact row: at most this many distinct
     * handles of at most `callbackBytes` each (4 * 512 = 2 KiB, which keeps the
     * row far below 8 KiB with its other bounded fields). Callers beyond the
     * limit are told `callback: "dropped"` and must poll `get`.
     */
    readonly callbacksPerArtifact: 4;
    readonly callbackBytes: 512;
    /** Artifact rows per `purge` transaction: 32 * < 4 KiB read and written. */
    readonly purgeBatch: 32;
    readonly indexLeaseMs: number;
    readonly providerMs: number;
    readonly outputTokens: 4096;
    readonly searchResults: 10;
    readonly chunkBytes: 8192;
    readonly minChunkBytes: 1024;
    readonly indexChunks: 1024;
    readonly ragBatch: 100;
    readonly vectorNumberBytes: 8;
    readonly embeddingDimensions: readonly [128, 256, 512, 768, 1024, 1408, 1536, 2048, 3072, 4096];
    readonly indexBytes: number;
    readonly embeddingDimension: 4096;
    readonly workflowVersion: 1;
    readonly initialAttempt: 1;
};
export type ExtractLimits = {
    maxBytes: {
        document: number;
        image: number;
        text: number;
    };
    payloadBytes: number;
    indexLeaseMs: number;
};
/** Reject non-integer or out-of-bound host overrides before they affect resource budgets. */
export declare function integer(value: number, max: number, min?: number): number;
/** Encode once so every text bound measures bytes rather than UTF-16 code units. */
export declare const utf8: (text: string) => Uint8Array<ArrayBuffer>;
/** Validate a nonempty identifier or text field against its hard UTF-8 byte ceiling. */
export declare function bounded(value: string, max?: number): string;
/**
 * `node` registrations (a Node worker is configured) may raise the byte ceilings
 * up to LIMITS.node; otherwise the default-runtime maxima are hard.
 */
export declare function resolveLimits(value?: Partial<Omit<ExtractLimits, "maxBytes">> & {
    maxBytes?: Partial<ExtractLimits["maxBytes"]>;
}, node?: boolean): ExtractLimits;
/** Return valid UTF-8 without splitting a multibyte character at the byte ceiling. */
export declare function sliceText(text: string, max: number): string;
