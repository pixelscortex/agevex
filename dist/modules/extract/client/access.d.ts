import { type ArtifactArgs, type FileArgs, type RuntimeContext } from "./context.js";
import type { ActionCtx, FileInfo, ProviderUsage, Scope } from "./types.js";
/** Validate scope identifiers before invoking the host policy on every access. */
export declare function authorize(runtime: RuntimeContext, ctx: ActionCtx, scope: Scope): Promise<void>;
/** Read one exact native file and its storage metadata; map missing objects to a safe failure. */
export declare function fileInfo(runtime: RuntimeContext, ctx: ActionCtx, fileId: string): Promise<{
    info: FileInfo;
    storage: string;
}>;
/** Choose the backend and stable extraction identity without changing paid deduplication. */
export declare function identity(runtime: RuntimeContext, ctx: ActionCtx, args: FileArgs): Promise<{
    file: {
        info: FileInfo;
        storage: string;
    };
    backend: import("./types.js").ExtractBackend | undefined;
    key: {
        fileId: string;
        backend: string;
        version: string;
        optionsHash: string;
    };
}>;
/** Load one exact artifact and reauthorize its current attachment before exposing it. */
export declare function raw(runtime: RuntimeContext, ctx: ActionCtx, args: ArtifactArgs, operation?: Scope["operation"], namespace?: string): Promise<{
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
}>;
/** Build the bounded public view without leaking provider bodies or storage details. */
export declare function view(row: NonNullable<Awaited<ReturnType<typeof raw>>>): {
    usage?: {
        credits?: number | undefined;
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
    } | undefined;
    failure?: {
        code: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED";
        retryable: boolean;
    } | undefined;
    summary?: {
        language?: string | undefined;
        kind: "document" | "text" | "image";
        textBytes: number;
        pages: number;
        preview: string;
    } | undefined;
    artifactId: string;
    fileId: string;
    backend: string;
    version: string;
    optionsHash: string;
    status: "failed" | "running" | "pending" | "unknown" | "ready" | "released";
    attempt: number;
};
/** Report sanitized paid usage after execution or acquisition through the optional host hook. */
export declare function record(runtime: RuntimeContext, ctx: ActionCtx, args: {
    artifactId?: string;
    fileId?: string;
    threadId: string;
    backend: string;
}, usage?: ProviderUsage): Promise<void>;
