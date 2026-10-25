import { readFile, writeFile } from "node:fs/promises";
import { it, expect } from "vite-plus/test";
import { createOpenAI } from "@ai-sdk/openai";
import { setup } from "./setup.js";
import { directText, firecrawlParse, visionOcr } from "../../src/extract/index.js";
import { readResponse } from "../../src/extract/backends.js";
const LIVE_LIMITS = { calls: 3, providerMs: 180_000, pdfBytes: 64 * 1024 } as const;
const scope = { threadId: "owner" };
let firecrawlCalls = 0;
let credits = 0;
let modelCalls = 0;
let routedModel: string | undefined;
const usage = { inputTokens: 0, outputTokens: 0 };
async function ready(h: ReturnType<typeof setup>, fileId: string) {
  const job = await h.action((ctx) => h.extract.run(ctx, { ...scope, fileId }));
  await expect
    .poll(
      async () => {
        const row = await h.action((ctx) =>
          h.extract.get(ctx, { ...scope, artifactId: job.artifactId }),
        );
        if (row?.status === "failed" || row?.status === "unknown")
          throw new Error(`EXTRACT_LIVE_${row.status}:${row.failure?.code ?? "unknown"}`);
        return row?.status;
      },
      { timeout: LIVE_LIMITS.providerMs, interval: 100 },
    )
    .toBe("ready");
  const artifact = await h.action((ctx) =>
    h.extract.get(ctx, { ...scope, artifactId: job.artifactId }),
  );
  credits += artifact?.usage?.credits ?? 0;
  usage.inputTokens += artifact?.usage?.inputTokens ?? 0;
  usage.outputTokens += artifact?.usage?.outputTokens ?? 0;
  return h.action((ctx) => h.extract.readText(ctx, { ...scope, artifactId: job.artifactId }));
}
it("live directText reads an Agent text file without provider credits", async () => {
  const h = setup({ backends: [directText()] });
  const text = await ready(h, await h.upload("agevex local extraction"));
  expect(text.text).toBe("agevex local extraction");
});
it.skipIf(!process.env.FIRECRAWL_API_KEY)(
  "live Firecrawl parses one small public PDF and fetches one page within three calls",
  async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("https://api.firecrawl.dev/")) {
        if (++firecrawlCalls > LIVE_LIMITS.calls) throw new Error("LIVE_FIRECRAWL_CAP");
      }
      return original(url, init);
    }) as typeof fetch;
    try {
      const h = setup({
        backends: [firecrawlParse({ apiKey: () => process.env.FIRECRAWL_API_KEY! }), directText()],
      });
      const response = await fetch(
        "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
      );
      expect(response.ok).toBe(true);
      const bytes = await readResponse(response, LIVE_LIMITS.pdfBytes);
      const fileId = await h.uploadBlob(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
        "dummy.pdf",
      );
      const parsed = await ready(h, fileId);
      expect(parsed.text.toLowerCase()).toContain("dummy pdf");
      const fetched = await h.action((ctx) =>
        h.extract.fromUrl(ctx, { ...scope, url: "https://example.com" }),
      );
      credits += fetched.usage?.credits ?? 0;
      expect(fetched.fileId).toBeTruthy();
      expect(firecrawlCalls).toBeLessThanOrEqual(LIVE_LIMITS.calls);
    } finally {
      globalThis.fetch = original;
      await evidence();
    }
  },
  LIVE_LIMITS.providerMs,
);
it.skipIf(!process.env.OPENROUTER_API_KEY)(
  "live visionOcr transcribes one tiny PNG with openrouter/free and no retries",
  async () => {
    const model = createOpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      fetch: async (url, init) => {
        if (++modelCalls > 1) throw new Error("LIVE_VISION_CALL_CAP");
        const response = await fetch(url, init);
        const data = (await response.clone().json()) as { model?: string };
        routedModel = data.model;
        return response;
      },
    }).chat("openrouter/free");
    const h = setup({ backends: [visionOcr({ model })] });
    try {
      const bytes = await readFile(new URL("./fixtures/ocr.png", import.meta.url));
      const fileId = await h.uploadBlob(new Blob([bytes], { type: "image/png" }), "ocr.png");
      const text = await ready(h, fileId);
      expect(text.text.toUpperCase()).toContain("AGEVEX");
      expect(text.text).toContain("42");
      expect(modelCalls).toBe(1);
    } finally {
      await evidence();
    }
  },
  LIVE_LIMITS.providerMs,
);
async function evidence() {
  const result = {
    firecrawlCalls,
    reportedFirecrawlCredits: credits,
    requestedModel: "openrouter/free",
    routedModel,
    modelCalls,
    ...usage,
  };
  await writeFile(".vite-plus/extract-live-results.json", JSON.stringify(result) + "\n");
  console.log(JSON.stringify(result));
}
