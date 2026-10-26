import { type ArtifactArgs, type RuntimeContext } from "./context.js";
import type { ActionCtx, NodeReadArgs } from "./types.js";
/** Authorize, require `ready`, and learn the payload size without reading the payload. */
export declare function payloadRef(runtime: RuntimeContext, ctx: ActionCtx, args: ArtifactArgs): Promise<{
    row: {
        _id: string;
        _creationTime: number;
        summary?: {
            language?: string | undefined;
            kind: "document" | "text" | "image";
            textBytes: number;
            pages: number;
            preview: string;
        } | undefined;
        usage?: {
            credits?: number | undefined;
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
        } | undefined;
        failure?: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED" | undefined;
        payloadStorageId?: string | undefined;
        callbacks?: string[] | undefined;
        status: "failed" | "running" | "pending" | "unknown" | "ready" | "released";
        version: string;
        claim: string;
        leaseUntil: number;
        fileId: string;
        backend: string;
        attempt: number;
        optionsHash: string;
    };
    storage: string;
    size: number;
}>;
/**
 * One blob read, one UTF-8 decode and one JSON parse; nothing else copies the
 * payload. Size is checked from metadata before the read and again on the
 * actual blob, against this runtime's ceiling (LIMITS has the arithmetic).
 */
export declare function readPayload(runtime: RuntimeContext, ctx: ActionCtx, ref: Awaited<ReturnType<typeof payloadRef>>): Promise<import("./types.js").ExtractedDoc>;
/** Validate and run one windowed read; delegates oversized payloads to the Node runtime. */
export declare function readWindow(runtime: RuntimeContext, ctx: ActionCtx, request: NodeReadArgs): Promise<unknown>;
/** Return one authorized UTF-8 byte window, delegating oversized payloads to Node. */
export declare function readText(runtime: RuntimeContext, ctx: ActionCtx, args: ArtifactArgs & {
    cursor?: number;
    maxBytes?: number;
}): Promise<{
    text: string;
    cursor: number | null;
    done: boolean;
}>;
/** Return bounded authorized page windows with resumable UTF-8 cursors. */
export declare function readPages(runtime: RuntimeContext, ctx: ActionCtx, args: ArtifactArgs & {
    from?: number;
    count?: number;
    cursor?: number;
    maxBytes?: number;
}): Promise<{
    pages: {
        number: number;
        text: string;
    }[];
    next: {
        from: number;
        cursor: number;
    } | null;
}>;
