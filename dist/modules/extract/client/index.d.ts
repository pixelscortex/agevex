import type { ComponentApi } from "../component/_generated/component.js";
import type { ActionCtx, ExtractOptions, NodeReadArgs } from "./types.js";
export type { ComponentApi } from "../component/_generated/component.js";
export { LIMITS } from "../shared/limits.js";
export { authorizeAttached } from "./adapter.js";
export { directText, ExtractError, firecrawlParse, visionOcr } from "./backends.js";
export type { BackendInput, BackendResult, ExtractBackend, ExtractedDoc, ExtractFailure, ExtractOptions, FileInfo, NodeReadArgs, Page, ProviderUsage, Scope, WorkerArgs, } from "./types.js";
/**
 * Standalone host helper. Export internalFunctions().execute as the worker
 * reference supplied here; only the component can create a valid dispatch
 * claim. Public host wrappers call these methods with the owning thread.
 */
export declare function defineExtract(component: ComponentApi, options: ExtractOptions): {
    run: (ctx: ActionCtx, args: import("./context.js").Scoped & {
        fileId: string;
        backend?: string;
        optionsHash?: string;
    } & {
        onComplete?: import("./context.js").Completion;
    }) => Promise<{
        artifactId: string;
        action: "run" | "wait" | "reuse";
        callback?: "stored" | "dropped" | undefined;
    }>;
    get: (ctx: ActionCtx, args: import("./context.js").FileArgs | import("./context.js").ArtifactArgs) => Promise<{
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
    fromUrl: (ctx: ActionCtx, args: import("./context.js").Scoped & {
        url: string;
    }) => Promise<{
        usage?: {
            credits?: number | undefined;
            inputTokens?: number | undefined;
            outputTokens?: number | undefined;
        } | undefined;
        fileId: string;
    }>;
    release: (ctx: ActionCtx, args: import("./context.js").Scoped & {
        artifactId: string;
    } & {
        namespace?: string;
    }) => Promise<null>;
    purge: (ctx: ActionCtx, args: {
        fileId: string;
    }) => Promise<{
        more: boolean;
    }>;
    readText: (ctx: ActionCtx, args: import("./context.js").Scoped & {
        artifactId: string;
    } & {
        cursor?: number;
        maxBytes?: number;
    }) => Promise<{
        text: string;
        cursor: number | null;
        done: boolean;
    }>;
    readPages: (ctx: ActionCtx, args: import("./context.js").Scoped & {
        artifactId: string;
    } & {
        from?: number;
        count?: number;
        cursor?: number;
        maxBytes?: number;
    }) => Promise<{
        pages: {
            number: number;
            text: string;
        }[];
        next: {
            from: number;
            cursor: number;
        } | null;
    }>;
    index: (ctx: ActionCtx, args: import("./context.js").Scoped & {
        artifactId: string;
    } & {
        namespace: string;
        key: string;
        automatic?: boolean;
    }) => Promise<{
        entryId: string | undefined;
        status: "pending" | "ready" | "skipped";
        created: boolean;
        replacedEntry: null;
        usage: {
            tokens: number;
        };
    }>;
    search: (ctx: ActionCtx, args: import("./context.js").Scoped & {
        namespace: string;
        query: string;
        limit?: number;
    }) => Promise<{
        text: string;
        references: {
            artifactId: string;
            fileId: string;
        }[];
        usage: import("ai").EmbeddingModelUsage;
    }>;
    tools: (context: import("./context.js").Scoped & {
        ctx: ActionCtx;
    }) => import("ai").ToolSet;
    internalFunctions: () => {
        storageMetadata: import("convex/server").RegisteredQuery<"internal", {
            storageId: string;
        }, Promise<{
            size: number;
        } | null>>;
        execute: import("convex/server").RegisteredAction<"internal", {
            subject?: string | undefined;
            threadId: string;
            claim: string;
            attempt: number;
            artifactId: string;
        }, Promise<null>>;
    };
    /** The Node runtime's authorized windowed read; see extractNodeExport. */
    nodeRead: (ctx: ActionCtx, request: NodeReadArgs) => Promise<unknown>;
    /**
     * The agevex extract slot: core admits each attached file at the first slice
     * and binds tools to the running thread and subject (see adapter.ts).
     * search_files is offered only with autoIndex so the namespace gets filled.
     */
    slot: () => import("../../../client/slots.js").ExtractSlot;
};
/**
 * Opt-in Node variant, exported from a host file beginning with "use node"
 * (512 MiB instead of 64 MiB):
 *
 * ```ts
 * "use node";
 * export const { execute, read } = extractNodeExport(components.agevexExtract, extractOptions);
 * ```
 *
 * Register those two references as `options.node` of `defineExtract`. Files
 * above the default byte ceilings are then extracted by `execute`, and
 * payloads above the default read ceiling are windowed by `read`; both repeat
 * authorization. See LIMITS for the memory arithmetic behind each runtime.
 */
export declare function extractNodeExport(component: ComponentApi, options: ExtractOptions): {
    execute: import("convex/server").RegisteredAction<"internal", {
        subject?: string | undefined;
        threadId: string;
        claim: string;
        attempt: number;
        artifactId: string;
    }, Promise<null>>;
    read: import("convex/server").RegisteredAction<"internal", {
        from?: number | undefined;
        subject?: string | undefined;
        cursor?: number | undefined;
        maxBytes?: number | undefined;
        count?: number | undefined;
        kind: "text" | "pages";
        threadId: string;
        artifactId: string;
    }, Promise<unknown>>;
};
