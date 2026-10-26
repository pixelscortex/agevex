/**
 * Transport adapters for Langfuse, Braintrust and custom one-shot exporters.
 * Calls are deadline-bounded and observer-only: no network failure can change
 * a managed action result, and unknown ingestion outcomes are never retried.
 */
import { checkCredential, resolveCredential, type Credential } from "./credential.js";
import { LIMITS, validateString } from "./limits.js";
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
export async function bestEffort(
  work: (signal: AbortSignal) => unknown,
  signal?: AbortSignal,
  ownDeadline = true,
): Promise<void> {
  if (signal?.aborted) return;

  const controller = new AbortController();
  let stop: () => void = () => {};

  const stopped = new Promise<void>((resolve) => {
    stop = () => {
      controller.abort();
      resolve();
    };
  });

  // Managed slots already receive core's bounded signal. They need the abort
  // race (custom exporters may ignore cancellation), but no second deadline.
  const timer = ownDeadline ? setTimeout(stop, LIMITS.exportTimeoutMs) : undefined;

  signal?.addEventListener("abort", stop, { once: true });

  try {
    await Promise.race([Promise.resolve().then(() => work(controller.signal)), stopped]);
  } catch {
    // Network, non-2xx and custom exporter failures never change the agent result.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    controller.abort();
  }
}

/** UTF-8 Basic auth without btoa or Buffer (neither is guaranteed in Convex V8). */
function base64(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const data = new TextEncoder().encode(value);
  let result = "";

  for (let index = 0; index < data.length; index += 3) {
    const a = data[index];
    const b = data[index + 1];
    const c = data[index + 2];

    result += alphabet[a >> 2];
    result += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    result += b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    result += c === undefined ? "=" : alphabet[c & 63];
  }

  return result;
}

/** Build a single HTTP attempt; cancel response bodies without exposing provider diagnostics. */
function httpExporter(url: string, headers: () => Promise<Record<string, string>>): Exporter {
  return {
    export: (body, signal) =>
      bestEffort(async (requestSignal) => {
        // Credentials resolve here, inside the fail-open attempt: an empty or
        // throwing getter sends nothing and never changes the agent result.
        const auth = await headers();

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify(body),
          signal: requestSignal,
        });

        // No provider diagnostic is logged: it may echo credentials or content.
        if (response.body) await response.body.cancel();

        if (!response.ok) throw new Error("Telemetry ingestion failed");
      }, signal),
  };
}

/**
 * Construct the Langfuse v4 OTLP adapter at registration time. The URL and any
 * literal keys are validated now; key getters run at each export, never here.
 */
export function langfuse(options: {
  baseUrl: string;
  publicKey: Credential;
  secretKey: Credential;
}): Exporter {
  validateString(options.baseUrl, "baseUrl", LIMITS.maxConfigurationBytes);
  checkCredential(options.publicKey, "publicKey");
  checkCredential(options.secretKey, "secretKey");

  const base = new URL(options.baseUrl);

  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid telemetry baseUrl");

  const endpoint = `${base.toString().replace(/\/$/, "")}/api/public/otel/v1/traces`;

  return httpExporter(endpoint, async () => {
    const publicKey = await resolveCredential(options.publicKey, "publicKey");
    const secretKey = await resolveCredential(options.secretKey, "secretKey");

    return {
      Authorization: `Basic ${base64(`${publicKey}:${secretKey}`)}`,
      "x-langfuse-ingestion-version": "4",
    };
  });
}

/** Bind a validated Braintrust project to a fail-open, one-attempt OTLP adapter.
 * `apiKey` may be a getter, called at each export and never at construction. */
export function braintrust(options: { apiKey: Credential; projectId: string }): Exporter {
  checkCredential(options.apiKey, "apiKey");
  validateString(options.projectId, "projectId", LIMITS.maxFactBytes);

  return httpExporter("https://api.braintrust.dev/otel/v1/traces", async () => ({
    Authorization: `Bearer ${await resolveCredential(options.apiKey, "apiKey")}`,
    "x-bt-parent": `project_id:${options.projectId}`,
  }));
}
