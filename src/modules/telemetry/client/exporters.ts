/**
 * Transport adapters for Langfuse, Braintrust and custom one-shot exporters.
 * Calls are deadline-bounded and observer-only: no network failure can change
 * a managed action result, and unknown ingestion outcomes are never retried.
 */
import {
  checkCredential,
  checkSetting,
  resolveCredential,
  resolveSetting,
  type Credential,
  type Setting,
} from "./credential.js";
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

/** Where one export goes: a validated endpoint plus resolved authorization headers. */
type Target = { url: string; headers: Record<string, string> };

/** Build a single HTTP attempt; cancel response bodies without exposing provider diagnostics. */
function httpExporter(target: () => Promise<Target>): Exporter {
  return {
    export: (body, signal) =>
      bestEffort(async (requestSignal) => {
        // Settings and credentials resolve here, inside the fail-open attempt: a
        // missing, invalid or throwing getter sends nothing and never changes
        // the agent result.
        const { url, headers } = await target();

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: requestSignal,
        });

        // No provider diagnostic is logged: it may echo credentials or content.
        if (response.body) await response.body.cancel();

        if (!response.ok) throw new Error("Telemetry ingestion failed");
      }, signal),
  };
}

/** Validate a Langfuse base URL and derive its v4 OTLP endpoint. */
function langfuseEndpoint(baseUrl: string): string {
  validateString(baseUrl, "baseUrl", LIMITS.maxConfigurationBytes);

  const base = new URL(baseUrl);

  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid telemetry baseUrl");

  return `${base.toString().replace(/\/$/, "")}/api/public/otel/v1/traces`;
}

/**
 * Construct the Langfuse v4 OTLP adapter at registration time. A literal URL and
 * any literal keys are validated now; getters run at each export, never here.
 * An invalid resolved `baseUrl` sends nothing instead of failing the agent.
 */
export function langfuse(options: {
  baseUrl: Setting;
  publicKey: Credential;
  secretKey: Credential;
}): Exporter {
  checkSetting(options.baseUrl, "baseUrl", LIMITS.maxConfigurationBytes);
  checkCredential(options.publicKey, "publicKey");
  checkCredential(options.secretKey, "secretKey");

  const fixed =
    typeof options.baseUrl === "function" ? undefined : langfuseEndpoint(options.baseUrl);

  return httpExporter(async () => {
    const url =
      fixed ??
      langfuseEndpoint(
        await resolveSetting(options.baseUrl, "baseUrl", LIMITS.maxConfigurationBytes),
      );

    const publicKey = await resolveCredential(options.publicKey, "publicKey");
    const secretKey = await resolveCredential(options.secretKey, "secretKey");

    return {
      url,
      headers: {
        Authorization: `Basic ${base64(`${publicKey}:${secretKey}`)}`,
        "x-langfuse-ingestion-version": "4",
      },
    };
  });
}

/** Bind a Braintrust project to a fail-open, one-attempt OTLP adapter.
 * `apiKey` and `projectId` may be getters, called at each export and never at
 * construction; an invalid resolved value sends nothing. */
export function braintrust(options: { apiKey: Credential; projectId: Setting }): Exporter {
  checkCredential(options.apiKey, "apiKey");
  checkSetting(options.projectId, "projectId", LIMITS.maxFactBytes);

  return httpExporter(async () => {
    const projectId = await resolveSetting(options.projectId, "projectId", LIMITS.maxFactBytes);

    return {
      url: "https://api.braintrust.dev/otel/v1/traces",
      headers: {
        Authorization: `Bearer ${await resolveCredential(options.apiKey, "apiKey")}`,
        "x-bt-parent": `project_id:${projectId}`,
      },
    };
  });
}
