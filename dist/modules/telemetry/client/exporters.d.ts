import type { OtlpPayload } from "./otlp.js";
/** One attempt only; flush never persists or retries an unknown ingestion outcome. */
export type Exporter = {
    export: (payload: OtlpPayload, signal?: AbortSignal) => PromiseLike<void> | void;
};
/**
 * Race as well as abort: a custom exporter or fetch implementation may ignore its
 * signal. Always remove listeners/timers, and observe late promise rejections.
 * Prior art: agents/src/runtime/trace_export.ts:82-125 (3 s abort, no retries).
 */
export declare function bestEffort(work: (signal: AbortSignal) => unknown, signal?: AbortSignal, ownDeadline?: boolean): Promise<void>;
/** Validate host credentials and construct the Langfuse v4 OTLP adapter at registration time. */
export declare function langfuse(options: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
}): Exporter;
/** Bind a validated Braintrust project to a fail-open, one-attempt OTLP adapter. */
export declare function braintrust(options: {
    apiKey: string;
    projectId: string;
}): Exporter;
