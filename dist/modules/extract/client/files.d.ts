import { type ArtifactArgs, type Completion, type FileArgs, type RuntimeContext, type Scoped } from "./context.js";
import type { ActionCtx } from "./types.js";
/** Authorize and admit one identity; only an admitted claim can dispatch paid extraction. */
export declare function run(runtime: RuntimeContext, ctx: ActionCtx, args: FileArgs & {
    onComplete?: Completion;
}): Promise<{
    artifactId: string;
    action: "run" | "wait" | "reuse";
    callback?: "stored" | "dropped" | undefined;
}>;
/** Read a bounded artifact view after exact attachment authorization. */
export declare function get(runtime: RuntimeContext, ctx: ActionCtx, args: FileArgs | ArtifactArgs): Promise<{
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
} | null>;
/** Authorize URL acquisition and account provider usage before validating or storing output. */
export declare function fromUrl(runtime: RuntimeContext, ctx: ActionCtx, args: Scoped & {
    url: string;
}): Promise<{
    usage?: {
        credits?: number | undefined;
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
    } | undefined;
    fileId: string;
}>;
