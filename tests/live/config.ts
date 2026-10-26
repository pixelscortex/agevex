/** Live-test spending policy belongs to the test harness, never the SDK runtime. */
export const LIVE_LIMITS = { maxUsd: 0.05, requests: 16, outputTokens: 4096 } as const;

/** Ordered OpenRouter server-side fallback; no client retries of paid work. */
export const LIVE_MODELS = ["openrouter/free"] as const;
