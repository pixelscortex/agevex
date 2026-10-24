// @vitest-environment edge-runtime
import { it, expect, vi } from "vite-plus/test";
import { mockModel } from "@convex-dev/agent";
import { directText, firecrawlParse, visionOcr, LIMITS } from "../../src/extract/index.js";
import { setup } from "./setup.js";
import { readResponse } from "../../src/extract/backends.js";
const input = (blob: Blob) => ({
  bytes: async () => blob,
  file: { fileId: "file", mimeType: blob.type, byteSize: blob.size, hash: "hash" },
  signal: new AbortController().signal,
});
it("Firecrawl parsing makes one bounded multipart request and keeps failure credits", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ success: false, creditsUsed: 1, error: "SECRET_PROVIDER_BODY" }),
        { status: 503 },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const backend = firecrawlParse({ apiKey: "fake-offline-key" });
  const result = await backend.run(input(new Blob(["pdf"], { type: "application/pdf" })));
  expect(result).toEqual({ ok: false, failure: "PROVIDER_UNAVAILABLE", usage: { credits: 1 } });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});
it("Firecrawl maps text pages without preserving provider response fields", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              markdown: "document text",
              pages: [{ markdown: "first page" }],
              metadata: { creditsUsed: 1 },
              secret: "PRIVATE",
            },
          }),
        ),
    ),
  );
  const result = await firecrawlParse({ apiKey: "fake-offline-key" }).run(
    input(new Blob(["pdf"], { type: "application/pdf" })),
  );
  expect(result).toEqual({
    ok: true,
    doc: { kind: "document", text: "document text", pages: [{ number: 1, text: "first page" }] },
    usage: { credits: 1 },
  });
});
it("provider response reads stop at their byte ceiling without trusting headers", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(LIMITS.summaryBytes + 1));
      },
      cancel() {
        canceled = true;
      },
    }),
  );
  await expect(readResponse(response, LIMITS.summaryBytes)).rejects.toThrow("TOO_LARGE");
  expect(canceled).toBe(true);
});
it("directText rejects malformed UTF-8 and routes supported local formats", async () => {
  const backend = directText();
  const result = await backend.run(
    input(new Blob([new Uint8Array([0xff])], { type: "text/plain" })),
  );
  expect(result).toEqual({ ok: false, failure: "UNREADABLE" });
  expect(backend.accepts({ mimeType: "application/json", byteSize: 1 })).toBe(true);
  expect(backend.accepts({ mimeType: "application/pdf", byteSize: 1 })).toBe(false);
});
it("vision OCR retains token usage and freezes model identity", async () => {
  const backend = visionOcr({
    model: mockModel({ content: [{ type: "text", text: "tiny image text" }] }),
  });
  const result = await backend.run(input(new Blob([new Uint8Array([1])], { type: "image/png" })));
  expect(result).toMatchObject({
    ok: true,
    doc: { kind: "image", text: "tiny image text" },
    usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
  });
});
it("fromUrl stores the fetched markdown as a native Agent file and records credits", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              markdown: "fetched text",
              metadata: { creditsUsed: 1 },
            },
          }),
        ),
    ),
  );
  const h = setup({ backends: [firecrawlParse({ apiKey: "fake-offline-key" }), directText()] });
  const saved = await h.action((ctx) =>
    h.extract.fromUrl(ctx, { threadId: "owner", url: "https://example.com" }),
  );
  expect(saved).toMatchObject({ fileId: expect.any(String), usage: { credits: 1 } });
  expect(h.state.events).toHaveLength(1);
  const doc = await h.t.query((await import("./setup.js")).agentComponent.files.get, {
    fileId: saved.fileId,
  });
  expect(doc?.mediaType).toBe("text/markdown");
});
