/**
 * Transport adapters for Langfuse, Braintrust and custom one-shot exporters.
 * Calls are deadline-bounded and observer-only: no network failure can change
 * a managed action result, and unknown ingestion outcomes are never retried.
 */
import { type Credential } from "./credential.js";
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
/**
 * Construct the Langfuse v4 OTLP adapter at registration time. The URL and any
 * literal keys are validated now; key getters run at each export, never here.
 */
export declare function langfuse(options: {
    baseUrl: string;
    publicKey: Credential;
    secretKey: Credential;
}): Exporter;
/** Bind a validated Braintrust project to a fail-open, one-attempt OTLP adapter.
 * `apiKey` may be a getter, called at each export and never at construction. */
export declare function braintrust(options: {
    apiKey: Credential;
    projectId: string;
}): Exporter;
