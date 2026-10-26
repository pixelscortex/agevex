/**
 * Provider adapters for direct text, Firecrawl parsing and URL fetches, and vision OCR.
 * Host execution calls these after authorization; adapters return a closed failure vocabulary.
 * Responses are bounded before decoding and provider retries stay disabled.
 */
import { generateText } from "ai";
import { LIMITS, bounded } from "../shared/limits.js";
/** Structured failures never contain provider error messages, request bodies, or credentials. */
export class ExtractError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
/**
 * Stream a provider response under the actual byte ceiling, even if the server
 * omits or lies about content-length. This prevents an action from allocating
 * an unbounded body before checking it. No provider body escapes this module.
 */
export async function readResponse(response, max) {
    if (Number(response.headers.get("content-length")) > max) {
        await response.body?.cancel();
        throw new ExtractError("TOO_LARGE");
    }
    const reader = response.body?.getReader();
    if (!reader)
        return new Uint8Array();
    const parts = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > max)
                throw new ExtractError("TOO_LARGE");
            parts.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }
    return bytes;
}
const textTypes = new Set([
    "application/json",
    "application/xml",
    "application/csv",
    "application/javascript",
]);
/** Routing and admission must agree, including application/* text formats. */
export const isTextMime = (mimeType) => mimeType.startsWith("text/") || textTypes.has(mimeType);
const documentTypes = new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
/** Decode supported local text without provider calls; malformed UTF-8 becomes a typed failure. */
export function directText() {
    return {
        id: "direct-text",
        version: "1",
        accepts: (file) => isTextMime(file.mimeType),
        run: async ({ bytes }) => {
            try {
                const text = new TextDecoder("utf-8", { fatal: true }).decode(await (await bytes()).arrayBuffer());
                return text.trim()
                    ? { ok: true, doc: { kind: "text", text } }
                    : { ok: false, failure: "EMPTY" };
            }
            catch (error) {
                if (error instanceof ExtractError)
                    throw error;
                return { ok: false, failure: "UNREADABLE" };
            }
        },
    };
}
/** Read only object envelopes; arbitrary provider fields never become durable state. */
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
/** Retain finite nonnegative provider credits even when the extraction itself failed. */
function credits(value) {
    return typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
        ? { credits: value }
        : undefined;
}
/** Normalize bounded Firecrawl output into the closed extraction contract and preserve usage. */
function parseFirecrawl(envelope, kind) {
    const root = record(envelope);
    const data = record(root.data);
    const metadata = record(data.metadata);
    const usage = credits(metadata.creditsUsed ?? root.creditsUsed);
    if (root.success === false)
        return { ok: false, failure: "PROVIDER_UNAVAILABLE", usage };
    const source = Array.isArray(data.pages) ? data.pages : [];
    if (source.length > LIMITS.totalPages)
        return { ok: false, failure: "TOO_LARGE", usage };
    const pages = source.map((page, index) => {
        const item = record(page);
        return {
            number: index + 1,
            text: typeof item.markdown === "string"
                ? item.markdown
                : typeof item.text === "string"
                    ? item.text
                    : "",
        };
    });
    const text = typeof data.markdown === "string" ? data.markdown : pages.map((page) => page.text).join("\n\n");
    if (!text.trim())
        return {
            ok: false,
            failure: typeof data.markdown === "string" ? "EMPTY" : "INVALID_OUTPUT",
            usage,
        };
    return { ok: true, doc: { kind, text, ...(pages.length ? { pages } : {}) }, usage };
}
/**
 * Source ladder: firecrawl-convex 0.1.1 src/client/index.ts:291 provides scrape
 * but no Parse. Its src/component/api.ts:102-137 retries paid requests and reads
 * an unbounded body, violating this package's rules. A single bounded fetch is
 * therefore the smallest compatible adapter; no Firecrawl tables are copied.
 */
export function firecrawlParse({ apiKey }) {
    const key = () => bounded(typeof apiKey === "function" ? apiKey() : apiKey, LIMITS.urlBytes);
    /** Make one bounded request; provider failures never trigger an automatic paid repeat. */
    async function request(path, body, signal, payloadBytes, json = false) {
        const response = await fetch(`https://api.firecrawl.dev/v2/${path}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key()}`,
                ...(json ? { "Content-Type": "application/json" } : {}),
            },
            body,
            signal,
        });
        const bytes = await readResponse(response, payloadBytes);
        let envelope;
        try {
            envelope = JSON.parse(new TextDecoder().decode(bytes));
        }
        catch {
            return { ok: false, failure: response.ok ? "INVALID_OUTPUT" : "PROVIDER_UNAVAILABLE" };
        }
        if (!response.ok) {
            const root = record(envelope);
            const usage = credits(record(record(root.data).metadata).creditsUsed ?? root.creditsUsed);
            return {
                ok: false,
                failure: response.status === 413
                    ? "TOO_LARGE"
                    : response.status === 422
                        ? "UNREADABLE"
                        : "PROVIDER_UNAVAILABLE",
                usage,
            };
        }
        return parseFirecrawl(envelope, path === "parse" ? "document" : "text");
    }
    return {
        id: "firecrawl-parse",
        version: "1",
        accepts: (file) => documentTypes.has(file.mimeType),
        run: async ({ bytes, file, signal, payloadBytes }) => {
            const body = new FormData();
            body.append("file", await bytes(), file.filename ?? "document.pdf");
            body.append("options", JSON.stringify({
                formats: ["markdown"],
                parsers: [{ type: "pdf", mode: "auto", pages: true }],
                timeout: LIMITS.providerMs,
            }));
            return request("parse", body, signal, payloadBytes ?? LIMITS.payloadBytes);
        },
        fromUrl: (url, signal, payloadBytes) => request("scrape", JSON.stringify({ url, formats: ["markdown"], timeout: LIMITS.providerMs }), signal, payloadBytes ?? LIMITS.payloadBytes, true),
    };
}
/** Bind OCR identity to an instantiated model and run each paid image request without retries. */
export function visionOcr({ model }) {
    // An opaque string cannot freeze a gateway's changing default. Require an
    // instantiated model and include provider/model id in identity so replacing
    // the host's model never silently reuses output from a different OCR model.
    if (typeof model === "string")
        throw new Error("EXTRACT_MODEL_INSTANCE_REQUIRED");
    return {
        id: "vision-ocr",
        version: `1:${model.provider}:${model.modelId}`,
        accepts: (file) => file.mimeType.startsWith("image/"),
        run: async ({ bytes, file, signal }) => {
            const blob = await bytes();
            const result = await generateText({
                model,
                maxRetries: 0,
                abortSignal: signal,
                maxOutputTokens: LIMITS.outputTokens,
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "Transcribe all visible text in this image. Return only the text, preserving line breaks.",
                            },
                            {
                                type: "file",
                                data: new Uint8Array(await blob.arrayBuffer()),
                                mediaType: file.mimeType,
                            },
                        ],
                    },
                ],
            });
            const usage = {
                inputTokens: result.usage.inputTokens ?? 0,
                outputTokens: result.usage.outputTokens ?? 0,
            };
            // A truncated OCR result is a paid failure, not a successful partial file.
            if (result.finishReason === "length")
                return { ok: false, failure: "INVALID_OUTPUT", usage };
            return result.text.trim()
                ? { ok: true, doc: { kind: "image", text: result.text }, usage }
                : { ok: false, failure: "EMPTY", usage };
        },
    };
}
