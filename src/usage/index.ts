/** Stateless usage helpers. Apps own persistence, reconciliation schedules and
 * retry policy; these helpers never invoke a model or create component tables. */
const LIMITS = {
  tokensPerMillion: 1_000_000,
  maxTokens: 1_000_000_000,
  responseBytes: 16_384,
  requestTimeoutMs: 30_000,
  generationIdBytes: 200,
} as const;

export type Tokens = { inputTokens: number; outputTokens: number };

/** Preserve missing evidence; accept both native Agent and SDK token shapes. */
function usageTokens(usage: unknown): Tokens | null {
  const value = usage as {
    inputTokens?: number | { total?: number };
    outputTokens?: number | { total?: number };
    promptTokens?: number;
    completionTokens?: number;
  } | null;

  const inputTokens =
    typeof value?.inputTokens === "object"
      ? value.inputTokens?.total
      : (value?.inputTokens ?? value?.promptTokens);

  const outputTokens =
    typeof value?.outputTokens === "object"
      ? value.outputTokens?.total
      : (value?.outputTokens ?? value?.completionTokens);

  return validTokens(inputTokens) && validTokens(outputTokens)
    ? { inputTokens, outputTokens }
    : null;
}

/** Untrusted counts must be finite, integral and within the helper cap. */
function validTokens(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= LIMITS.maxTokens
  );
}

/** Ported token-rate arithmetic; no inferred prices or remote model catalog.
 * Missing/invalid usage returns null, whereas zero usage estimates zero USD. */
export function tokenEstimate(rates: {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}): (event: { usage: unknown }) => { usd: number } | null {
  if (
    [rates.inputUsdPerMillion, rates.outputUsdPerMillion].some(
      (rate) => !Number.isFinite(rate) || rate < 0,
    )
  )
    throw new Error("INVALID_TOKEN_RATE");

  return ({ usage }) => {
    const tokens = usageTokens(usage);

    if (!tokens) return null;

    const usd =
      (tokens.inputTokens * rates.inputUsdPerMillion +
        tokens.outputTokens * rates.outputUsdPerMillion) /
      LIMITS.tokensPerMillion;

    return Number.isFinite(usd) ? { usd } : null;
  };
}

/** Read at most 16 KiB, even for chunked responses. Do not expose provider
 * response bodies or credentials in errors. The request has a 30-second bound. */
async function generationData(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();

  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const next = await reader.read();

      if (next.done) break;

      size += next.value.byteLength;

      if (size > LIMITS.responseBytes) throw new Error("USAGE_RESPONSE_TOO_LARGE");

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

  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Fetch one real generation cost. Null means evidence is not available yet
 * (including HTTP/network failure); the caller decides whether/when to retry.
 * Prefer native provider tokens, which OpenRouter uses for billing. */
export async function openRouterCost(options: {
  apiKey: string;
  generationId: string;
}): Promise<{ usd: number; tokens: Tokens | null } | null> {
  if (
    !options.apiKey.trim() ||
    !options.generationId.trim() ||
    new TextEncoder().encode(options.generationId).length > LIMITS.generationIdBytes
  )
    throw new Error("INVALID_GENERATION_LOOKUP");

  try {
    const response = await fetch(
      `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(options.generationId)}`,
      {
        headers: { Authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
      },
    );

    if (!response.ok) {
      await response.body?.cancel();

      return null;
    }

    const result = (await generationData(response)) as {
      data?: {
        id?: string;
        total_cost?: unknown;
        native_tokens_prompt?: number;
        native_tokens_completion?: number;
        tokens_prompt?: number;
        tokens_completion?: number;
      };
    } | null;

    const data = result?.data;
    const usd = data?.total_cost;

    if (
      data?.id !== options.generationId ||
      typeof usd !== "number" ||
      !Number.isFinite(usd) ||
      usd < 0
    )
      return null;

    return {
      usd,
      tokens: usageTokens({
        inputTokens: data.native_tokens_prompt ?? data.tokens_prompt,
        outputTokens: data.native_tokens_completion ?? data.tokens_completion,
      }),
    };
  } catch {
    return null;
  }
}
