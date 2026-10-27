/** Offline pricing/reconciliation guarantees; the app chooses every retry. */
import { afterEach, expect, it, vi } from "vite-plus/test";
import { openRouterCost, tokenEstimate } from "../src/usage/index.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  { inputTokens: 1000, outputTokens: 2000 },
  { inputTokens: { total: 1000 }, outputTokens: { total: 2000 } },
  { promptTokens: 1000, completionTokens: 2000 },
])("token estimates price native and SDK evidence without guessing rates (%j)", (usage) => {
  expect(tokenEstimate({ inputUsdPerMillion: 2, outputUsdPerMillion: 8 })({ usage })).toEqual({
    usd: 0.018,
  });
});

it("missing or invalid tokens stay unknown while zero usage prices zero", () => {
  const estimate = tokenEstimate({ inputUsdPerMillion: 2, outputUsdPerMillion: 8 });

  for (const usage of [
    undefined,
    {},
    { inputTokens: -1, outputTokens: 2 },
    { inputTokens: NaN, outputTokens: 1 },
    { inputTokens: 1.5, outputTokens: 2 },
  ])
    expect(estimate({ usage })).toBeNull();

  expect(estimate({ usage: { inputTokens: 0, outputTokens: 0 } })).toEqual({ usd: 0 });

  expect(() => tokenEstimate({ inputUsdPerMillion: Infinity, outputUsdPerMillion: 1 })).toThrow(
    "INVALID_TOKEN_RATE",
  );
});

it("OpenRouter lookup preserves real zero cost and prefers native billing tokens", async () => {
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            id: "gen-1",
            total_cost: 0,
            native_tokens_prompt: 12,
            native_tokens_completion: 4,
            tokens_prompt: 99,
            tokens_completion: 99,
          },
        }),
      ),
  );

  vi.stubGlobal("fetch", request);

  expect(await openRouterCost({ apiKey: "test-key", generationId: "gen-1" })).toEqual({
    usd: 0,
    tokens: { inputTokens: 12, outputTokens: 4 },
  });

  expect(request).toHaveBeenCalledTimes(1);

  expect(request).toHaveBeenCalledWith(
    "https://openrouter.ai/api/v1/generation?id=gen-1",
    expect.objectContaining({
      headers: { Authorization: "Bearer test-key" },
      signal: expect.any(AbortSignal),
    }),
  );
});

it.each([
  new Response(null, { status: 404 }),
  new Response('{"data":{"id":"another","total_cost":1}}'),
  new Response('{"data":{"id":"gen","total_cost":-1}}'),
  new Response('{"data":{"id":"gen"}}'),
  new Response("invalid json"),
  new Response("x".repeat(16_385)),
])("unavailable or invalid generation evidence returns null with one request", async (response) => {
  const request = vi.fn(async () => response);

  vi.stubGlobal("fetch", request);
  expect(await openRouterCost({ apiKey: "test-key", generationId: "gen" })).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it("network failures return null without retrying or leaking credentials", async () => {
  const request = vi.fn(async () => {
    throw new Error("network failure");
  });

  vi.stubGlobal("fetch", request);
  expect(await openRouterCost({ apiKey: "test-key", generationId: "gen" })).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it("cost can be available before token evidence without fabricating token counts", async () => {
  vi.stubGlobal("fetch", async () => new Response('{"data":{"id":"gen","total_cost":0.04}}'));

  expect(await openRouterCost({ apiKey: "test-key", generationId: "gen" })).toEqual({
    usd: 0.04,
    tokens: null,
  });
});
