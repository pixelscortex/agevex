/** OpenRouter billing evidence adapter. Credentials stay in the host action;
 * this performs only GET /generation, never a completion or provider retry.
 */
import { LIMITS, text } from "../shared/limits.js";
import { openRouterCost } from "./helpers.js";
import type { Provider } from "./types.js";

/** Bound even chunked/error responses; never retain or expose provider bodies. */
async function generationCost(response: Response, requestId: string) {
  if (!response.ok) {
    await response.body?.cancel();

    return undefined;
  }

  const reader = response.body?.getReader();

  if (!reader) return undefined;

  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const next = await reader.read();

      if (next.done) break;

      size += next.value.byteLength;

      if (size > LIMITS.maxResponseBytes) throw new Error("METER_LOOKUP_RESPONSE_TOO_LARGE");

      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const result = JSON.parse(new TextDecoder().decode(bytes)) as {
    data?: { id?: string; total_cost?: unknown };
  };

  const cost = result?.data?.total_cost;

  if (
    result?.data?.id !== requestId ||
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost < 0
  )
    return undefined;

  return { usd: cost };
}

/** Inline cost is authoritative; optional estimates use host-configured rates.
 * Supply workers.lookup to defineMeter whenever this adapter is registered. */
export function openRouterProvider(options: {
  apiKey: string | (() => string | Promise<string>);
  estimate?: Provider["estimate"];
  fetch?: typeof fetch;
  lookupFor?: Provider["lookupFor"];
}): Provider {
  return {
    inline: ({ providerMetadata }) => {
      const usd = openRouterCost(providerMetadata);

      return usd === undefined ? undefined : { usd };
    },
    estimate: options.estimate,
    lookupFor: options.lookupFor,
    lookup: async (_ctx, requestId) => {
      text(requestId, "REQUEST_ID");
      const apiKey = typeof options.apiKey === "function" ? await options.apiKey() : options.apiKey;

      const response = await (options.fetch ?? fetch)(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(requestId)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
        },
      );

      return await generationCost(response, requestId);
    },
  };
}
