// Bounded attachment downloads for one generation.
//
// `boundedDownload` is passed to native `streamText` as `experimental_download`
// by `turn/generation.ts`. It streams every URL the model cannot fetch itself and
// enforces one shared byte budget (the turn's `attachmentBytes`) across all files
// of the generation, so an attacker-controlled file can never exhaust the
// action's memory. Touches no tables.

import type { Experimental_DownloadFunction } from "ai";
import { ConvexError } from "convex/values";

/** AI SDK 7 streamText accepts experimental_download (ai/src/generate-text/
 * stream-text.ts:641); the hook receives URLs from the ENTIRE prompt, including
 * prior attachments (ai/src/prompt/convert-to-language-model-prompt.ts:424-490).
 * Do not use arrayBuffer(): Content-Length is untrusted and could allocate past
 * Convex's 64 MiB action memory before we can reject. Sequential readers share
 * one budget across files and hook invocations for this generation.
 * At the hard max, retained bytes <=16 MiB; concatenating the current file adds
 * <=16 MiB transiently, leaving 32 MiB for Agent/model state. */
export function boundedDownload(
  maxBytes: number,
  signal: AbortSignal,
): Experimental_DownloadFunction {
  let total = 0;

  return async (requests) => {
    const results: ({ data: Uint8Array; mediaType: string | undefined } | null)[] = [];

    for (const { url, isUrlSupportedByModel } of requests) {
      if (isUrlSupportedByModel) {
        results.push(null);
        continue;
      }

      const response = await fetch(url, { signal });

      if (!response.ok || !response.body) throw new Error("FILE_DOWNLOAD_FAILED");

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          size += value.byteLength;
          total += value.byteLength;

          if (size > maxBytes || total > maxBytes) {
            await reader.cancel();
            throw new ConvexError({ code: "ATTACHMENT_LIMIT" });
          }

          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      const data = new Uint8Array(size);
      let offset = 0;

      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }

      results.push({ data, mediaType: response.headers.get("content-type")?.split(";")[0] });
    }

    return results;
  };
}
