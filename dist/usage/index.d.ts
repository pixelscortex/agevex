export type Tokens = {
    inputTokens: number;
    outputTokens: number;
};
/** Ported token-rate arithmetic; no inferred prices or remote model catalog.
 * Missing/invalid usage returns null, whereas zero usage estimates zero USD. */
export declare function tokenEstimate(rates: {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
}): (event: {
    usage: unknown;
}) => {
    usd: number;
} | null;
/** Fetch one real generation cost. Null means evidence is not available yet
 * (including HTTP/network failure); the caller decides whether/when to retry.
 * Prefer native provider tokens, which OpenRouter uses for billing. */
export declare function openRouterCost(options: {
    apiKey: string;
    generationId: string;
}): Promise<{
    usd: number;
    tokens: Tokens | null;
} | null>;
