/**
 * Provider adapters for direct text, Firecrawl parsing and URL fetches, and vision OCR.
 * Host execution calls these after authorization; adapters return a closed failure vocabulary.
 * Responses are bounded before decoding and provider retries stay disabled.
 */
import { type LanguageModel } from "ai";
import type { ExtractBackend, ExtractFailure } from "./types.js";
/** Structured failures never contain provider error messages, request bodies, or credentials. */
export declare class ExtractError extends Error {
    readonly code: ExtractFailure;
    constructor(code: ExtractFailure);
}
/**
 * Stream a provider response under the actual byte ceiling, even if the server
 * omits or lies about content-length. This prevents an action from allocating
 * an unbounded body before checking it. No provider body escapes this module.
 */
export declare function readResponse(response: Response, max: number): Promise<Uint8Array>;
/** Routing and admission must agree, including application/* text formats. */
export declare const isTextMime: (mimeType: string) => boolean;
/** Decode supported local text without provider calls; malformed UTF-8 becomes a typed failure. */
export declare function directText(): ExtractBackend;
/**
 * Source ladder: firecrawl-convex 0.1.1 src/client/index.ts:291 provides scrape
 * but no Parse. Its src/component/api.ts:102-137 retries paid requests and reads
 * an unbounded body, violating this package's rules. A single bounded fetch is
 * therefore the smallest compatible adapter; no Firecrawl tables are copied.
 */
export declare function firecrawlParse({ apiKey }: {
    apiKey: string | (() => string);
}): ExtractBackend;
/** Bind OCR identity to an instantiated model and run each paid image request without retries. */
export declare function visionOcr({ model }: {
    model: LanguageModel;
}): ExtractBackend;
