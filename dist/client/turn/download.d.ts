import type { Experimental_DownloadFunction } from "ai";
/** AI SDK 7 streamText accepts experimental_download (ai/src/generate-text/
 * stream-text.ts:641); the hook receives URLs from the ENTIRE prompt, including
 * prior attachments (ai/src/prompt/convert-to-language-model-prompt.ts:424-490).
 * Do not use arrayBuffer(): Content-Length is untrusted and could allocate past
 * Convex's 64 MiB action memory before we can reject. Sequential readers share
 * one budget across files and hook invocations for this generation.
 * At the hard max, retained bytes <=16 MiB; concatenating the current file adds
 * <=16 MiB transiently, leaving 32 MiB for Agent/model state. */
export declare function boundedDownload(maxBytes: number, signal: AbortSignal): Experimental_DownloadFunction;
