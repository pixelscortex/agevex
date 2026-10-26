/**
 * Resolved configuration and shared host request contracts.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { RAG } from "@convex-dev/rag";
import type { FunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import type { ExtractOptions } from "./types.js";
/**
 * `subject` is the thread owner a caller already knows (the agevex slot's tool
 * context carries it). It is forwarded to the host `authorize` callback so the
 * exact-attachment check can name its subject; background calls (`execute`)
 * have no caller and let the host resolve the owner from the thread instead.
 */
export type Scoped = {
    threadId: string;
    subject?: string;
};
/** Forward an optional subject without writing `subject: undefined` into scopes. */
export declare const subjectOf: (args: {
    subject?: string;
}) => {
    subject?: undefined;
} | {
    subject: string;
};
export type FileArgs = Scoped & {
    fileId: string;
    backend?: string;
    optionsHash?: string;
};
export type ArtifactArgs = Scoped & {
    artifactId: string;
};
export type Completion = FunctionReference<"mutation", "internal", {
    artifactId: string;
}, null | void>;
/** Cast an exact storage id at the host boundary; callers handle missing objects explicitly. */
export declare const storageId: (id: string) => GenericId<"_storage">;
/** Fixed identity backend of files that no configured backend accepts. */
export declare const UNSUPPORTED_BACKEND = "unsupported";
export declare const retryable: Set<string>;
/** The runtime-specific byte ceiling (see LIMITS) is chosen by input kind. */
export declare const kindOf: (mimeType: string) => "document" | "image" | "text";
export type RuntimeContext = ReturnType<typeof resolveRuntime>;
/** Resolve registration options once; actions receive the same bounds and model. */
export declare function resolveRuntime(component: ComponentApi, options: ExtractOptions, nodeRuntime: boolean): {
    component: {
        artifacts: {
            admit: FunctionReference<"mutation", "internal", {
                fileId: string;
                backend: string;
                version: string;
                optionsHash: string;
                worker: string;
                threadId: string;
                subject?: string | undefined;
                onComplete?: string | undefined;
            }, {
                artifactId: string;
                action: "run" | "wait" | "reuse";
                callback?: "stored" | "dropped" | undefined;
            }, string | undefined>;
            reject: FunctionReference<"mutation", "internal", {
                fileId: string;
                version: string;
                failure: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED";
                backend: string;
                optionsHash: string;
            }, string, string | undefined>;
            get: FunctionReference<"query", "internal", {
                artifactId: string;
            }, {
                _id: string;
                _creationTime: number;
                usage?: {
                    credits?: number | undefined;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                } | undefined;
                summary?: {
                    language?: string | undefined;
                    kind: "document" | "text" | "image";
                    textBytes: number;
                    pages: number;
                    preview: string;
                } | undefined;
                failure?: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED" | undefined;
                payloadStorageId?: string | undefined;
                callbacks?: string[] | undefined;
                status: "failed" | "running" | "pending" | "unknown" | "ready" | "released";
                claim: string;
                leaseUntil: number;
                fileId: string;
                version: string;
                backend: string;
                attempt: number;
                optionsHash: string;
            } | null, string | undefined>;
            lookup: FunctionReference<"query", "internal", {
                fileId: string;
                version: string;
                backend: string;
                optionsHash: string;
            }, {
                _id: string;
                _creationTime: number;
                usage?: {
                    credits?: number | undefined;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                } | undefined;
                summary?: {
                    language?: string | undefined;
                    kind: "document" | "text" | "image";
                    textBytes: number;
                    pages: number;
                    preview: string;
                } | undefined;
                failure?: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED" | undefined;
                payloadStorageId?: string | undefined;
                callbacks?: string[] | undefined;
                status: "failed" | "running" | "pending" | "unknown" | "ready" | "released";
                claim: string;
                leaseUntil: number;
                fileId: string;
                version: string;
                backend: string;
                attempt: number;
                optionsHash: string;
            } | null, string | undefined>;
            start: FunctionReference<"mutation", "internal", {
                claim: string;
                attempt: number;
                artifactId: string;
            }, boolean, string | undefined>;
            complete: FunctionReference<"mutation", "internal", {
                unknown?: boolean | undefined;
                usage?: {
                    credits?: number | undefined;
                    inputTokens?: number | undefined;
                    outputTokens?: number | undefined;
                } | undefined;
                summary?: {
                    language?: string | undefined;
                    kind: "document" | "text" | "image";
                    textBytes: number;
                    pages: number;
                    preview: string;
                } | undefined;
                failure?: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED" | undefined;
                payloadStorageId?: string | undefined;
                claim: string;
                attempt: number;
                artifactId: string;
            }, boolean, string | undefined>;
            purge: FunctionReference<"mutation", "internal", {
                fileId: string;
                after: number;
            }, {
                storageIds: string[];
                artifactIds: string[];
                next: number | null;
            }, string | undefined>;
        };
        indexing: {
            admit: FunctionReference<"mutation", "internal", {
                leaseMs?: number | undefined;
                automatic?: boolean | undefined;
                key: string;
                artifactId: string;
                namespace: string;
            }, {
                action: "wait";
                indexId: string;
                entryId: string | undefined;
                claim?: undefined;
            } | {
                action: "reuse";
                indexId: string;
                entryId: string | undefined;
                claim?: undefined;
            } | {
                action: "skip";
                indexId: string;
                entryId: string | undefined;
                claim?: undefined;
            } | {
                action: "run";
                indexId: string;
                claim: `${string}-${string}-${string}-${string}-${string}`;
                entryId: string | undefined;
            }, string | undefined>;
            lookup: FunctionReference<"query", "internal", {
                artifactId: string;
                namespace: string;
            }, {
                indexId: string;
                status: "failed" | "running" | "unknown" | "ready" | "released" | "cleaning";
                key: string;
                leaseUntil: number;
                entryId: string | undefined;
                claim: string;
            } | null, string | undefined>;
            release: FunctionReference<"mutation", "internal", {
                artifactId: string;
                namespace: string;
            }, {
                indexId: string;
                entryId: string | null;
            } | null, string | undefined>;
            purgeBatch: FunctionReference<"mutation", "internal", {
                limit: number;
                artifactId: string;
            }, {
                entries: {
                    indexId: string;
                    entryId: string | null;
                }[];
                more: boolean;
            }, string | undefined>;
            forget: FunctionReference<"mutation", "internal", {
                entryId: string | null;
                indexId: string;
            }, null, string | undefined>;
            start: FunctionReference<"mutation", "internal", {
                key: string;
                claim: string;
                indexId: string;
                add: string;
                namespaceId: string;
                contentHash: string;
            }, string, string | undefined>;
            insert: FunctionReference<"mutation", "internal", {
                claim: string;
                startOrder: number;
                indexId: string;
                insert: string;
                chunks: {
                    content: {
                        text: string;
                    };
                    searchableText: string;
                    embedding: number[];
                }[];
            }, boolean, string | undefined>;
            complete: FunctionReference<"mutation", "internal", {
                promote?: string | undefined;
                claim: string;
                indexId: string;
            }, boolean, string | undefined>;
        };
    };
    options: ExtractOptions;
    nodeRuntime: boolean;
    limits: import("../shared/limits.js").ExtractLimits;
    backends: import("./types.js").ExtractBackend[];
    ceiling: (kind: "document" | "image" | "text") => number;
    payloadCeiling: number;
    rag: RAG<Record<string, import("convex/values").Value>, Record<string, import("convex/values").Value>> | undefined;
};
/** Bind one named operation to the resolved context without changing its host signature. */
export declare function bindRuntime<Args extends unknown[], Result>(runtime: RuntimeContext, operation: (runtime: RuntimeContext, ...args: Args) => Result): (...args: Args) => Result;
