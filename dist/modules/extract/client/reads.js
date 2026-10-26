/**
 * Metadata-first payload reads and bounded text/page windows.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { LIMITS, bounded, integer, utf8 } from "../shared/limits.js";
import { raw } from "./access.js";
import { ExtractError } from "./backends.js";
import { storageId } from "./context.js";
import { readDocument, textWindow } from "./payload.js";
/** Authorize, require `ready`, and learn the payload size without reading the payload. */
export async function payloadRef(runtime, ctx, args) {
    const row = await raw(runtime, ctx, args);
    if (row.status !== "ready" || !row.payloadStorageId)
        throw new Error("EXTRACT_NOT_READY");
    const meta = await ctx.runQuery(runtime.options.storageMetadata, {
        storageId: row.payloadStorageId,
    });
    if (!meta)
        throw new ExtractError("OBJECT_UNAVAILABLE");
    return { row, storage: row.payloadStorageId, size: meta.size };
}
/**
 * One blob read, one UTF-8 decode and one JSON parse; nothing else copies the
 * payload. Size is checked from metadata before the read and again on the
 * actual blob, against this runtime's ceiling (LIMITS has the arithmetic).
 */
export async function readPayload(runtime, ctx, ref) {
    if (ref.size > runtime.payloadCeiling)
        throw new ExtractError("TOO_LARGE");
    const blob = await ctx.storage.get(storageId(ref.storage));
    if (!blob)
        throw new ExtractError("OBJECT_UNAVAILABLE");
    if (blob.size > runtime.payloadCeiling)
        throw new ExtractError("TOO_LARGE");
    let value;
    try {
        value = JSON.parse(await blob.text());
    }
    catch {
        throw new ExtractError("INVALID_OUTPUT");
    }
    return readDocument(value);
}
/** Validate and run one windowed read; delegates oversized payloads to the Node runtime. */
export async function readWindow(runtime, ctx, request) {
    bounded(request.artifactId);
    const max = integer(request.maxBytes ?? LIMITS.readBytes, LIMITS.readBytes, 1);
    if (request.kind === "text")
        integer(request.cursor ?? 0, LIMITS.node.payloadBytes);
    const from = integer(request.from ?? 1, LIMITS.totalPages, 1);
    const count = integer(request.count ?? LIMITS.pages, LIMITS.pages, 1);
    const cursor = integer(request.cursor ?? 0, LIMITS.node.payloadBytes);
    const ref = await payloadRef(runtime, ctx, request);
    if (!runtime.nodeRuntime && runtime.options.node && ref.size > LIMITS.payloadBytes)
        return ctx.runAction(runtime.options.node.read, request);
    const doc = await readPayload(runtime, ctx, ref);
    if (request.kind === "text")
        return textWindow(doc.text, cursor, max);
    const source = doc.pages?.length ? doc.pages : [{ number: 1, text: doc.text }];
    const pages = [];
    let remaining = max;
    let next = null;
    // At most 100 pages AND 1 MiB text total, even when a single page is huge.
    // Payload parsing is an action storage read, not a DB transaction.
    for (const page of source.slice(from - 1, from - 1 + count)) {
        if (remaining === 0) {
            next = { from: page.number, cursor: 0 };
            break;
        }
        let window;
        try {
            window = textWindow(page.text, page.number === from ? cursor : 0, remaining);
        }
        catch (error) {
            if (pages.length && error instanceof Error && error.message === "EXTRACT_WINDOW_TOO_SMALL") {
                next = { from: page.number, cursor: 0 };
                break;
            }
            throw error;
        }
        pages.push({ number: page.number, text: window.text });
        remaining -= utf8(window.text).length;
        if (!window.done) {
            next = { from: page.number, cursor: window.cursor };
            break;
        }
        next = page.number < source.length ? { from: page.number + 1, cursor: 0 } : null;
    }
    return { pages, next };
}
/** Return one authorized UTF-8 byte window, delegating oversized payloads to Node. */
export async function readText(runtime, ctx, args) {
    return (await readWindow(runtime, ctx, { kind: "text", ...args }));
}
/** Return bounded authorized page windows with resumable UTF-8 cursors. */
export async function readPages(runtime, ctx, args) {
    return (await readWindow(runtime, ctx, { kind: "pages", ...args }));
}
