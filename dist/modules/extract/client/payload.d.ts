import type { ExtractedDoc, ProviderUsage } from "./types.js";
/** Strip unknown fields: provider bodies must never be copied into durable JSON. */
export declare function parseDocument(value: unknown): ExtractedDoc;
/**
 * Reads trust what `document` validated and stored: re-running the schema would
 * copy every page object again (and `trim` the whole text) on each window. Check
 * only the shape the readers touch, without allocating.
 */
export declare function readDocument(value: unknown): ExtractedDoc;
/** Serialize only on writes; a read must not allocate another full 32 MiB JSON blob. */
export declare function document(value: unknown, maxBytes: number): {
    doc: ExtractedDoc;
    blob: Blob;
};
/** Accept only finite nonnegative usage fields before crossing storage or accounting boundaries. */
export declare function cleanUsage(usage: ProviderUsage | undefined): ProviderUsage | undefined;
/** Cursor is a UTF-8 byte offset. Reject mid-character offsets, preventing corrupt or duplicated text. */
export declare function textWindow(text: string | Uint8Array, cursor: number, maxBytes: number): {
    text: string;
    cursor: number | null;
    done: boolean;
};
