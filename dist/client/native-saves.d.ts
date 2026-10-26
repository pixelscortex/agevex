import { saveMessage } from "@convex-dev/agent";
import type { CoordinatorCtx, RuntimeContext } from "./registration/context.js";
import type { ManagedAgent } from "./types.js";
type SavedMessage = Awaited<ReturnType<typeof saveMessage>>;
/**
 * The exact identity of one native save, as the component stores it.
 * `bytes` is the saved document's Convex size, so review-delta reads can be
 * bounded by bytes without loading the message.
 */
export declare function savedMessageRef(messageId: string, message: SavedMessage["message"]): {
    id: string;
    order: number;
    stepOrder: number;
    bytes: number;
};
/**
 * Save one native message and, when reviews or summaries are enabled, capture its exact
 * identity for that thread's review delta in the same transaction.
 *
 * Without reviews or summaries nothing reads the capture, so it is skipped entirely.
 */
export declare function saveTrackedMessage(rt: RuntimeContext, ctx: CoordinatorCtx, native: ManagedAgent["component"], args: Parameters<typeof saveMessage>[2]): Promise<{
    messageId: string;
    message: {
        id?: string | undefined;
        userId?: string | undefined;
        embeddingId?: string | undefined;
        fileIds?: string[] | undefined;
        error?: string | undefined;
        agentName?: string | undefined;
        model?: string | undefined;
        provider?: string | undefined;
        providerOptions?: Record<string, Record<string, any>> | undefined;
        message?: {
            providerOptions?: Record<string, Record<string, any>> | undefined;
            role: "user";
            content: string | ({
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                type: "text";
                text: string;
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                mediaType?: string | undefined;
                mimeType?: string | undefined;
                type: "image";
                image: string | ArrayBuffer | {
                    type: "reference";
                    reference: Record<string, string>;
                };
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                mediaType?: string | undefined;
                mimeType?: string | undefined;
                filename?: string | undefined;
                type: "file";
                data: string | ArrayBuffer | {
                    type: "reference";
                    reference: Record<string, string>;
                };
            })[];
        } | {
            providerOptions?: Record<string, Record<string, any>> | undefined;
            role: "assistant";
            content: string | ({
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                type: "text";
                text: string;
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                mediaType?: string | undefined;
                mimeType?: string | undefined;
                filename?: string | undefined;
                type: "file";
                data: string | ArrayBuffer | {
                    type: "reference";
                    reference: Record<string, string>;
                };
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                signature?: string | undefined;
                type: "reasoning";
                text: string;
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                data?: string | ArrayBuffer | undefined;
                url?: string | undefined;
                type: "reasoning-file";
                mediaType: string;
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                type: "custom";
                kind: string;
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                type: "redacted-reasoning";
                data: string;
            } | {
                title?: string | undefined;
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                args?: any;
                providerExecuted?: boolean | undefined;
                toolMetadata?: Record<string, any> | undefined;
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                input: any;
            } | {
                title?: string | undefined;
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                input?: any;
                providerExecuted?: boolean | undefined;
                toolMetadata?: Record<string, any> | undefined;
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                args: any;
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                args?: any;
                providerExecuted?: boolean | undefined;
                output?: {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    type: "text";
                    value: string;
                } | {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    type: "json";
                    value: any;
                } | {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    type: "error-text";
                    value: string;
                } | {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    type: "error-json";
                    value: any;
                } | {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    reason?: string | undefined;
                    type: "execution-denied";
                } | {
                    type: "content";
                    value: ({
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "text";
                        text: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        filename?: string | undefined;
                        type: "file";
                        mediaType: string;
                        data: {
                            type: "reference";
                            reference: Record<string, string>;
                        } | {
                            type: "url";
                            url: string;
                        } | {
                            type: "data";
                            data: string | ArrayBuffer;
                        } | {
                            type: "text";
                            text: string;
                        };
                    } | {
                        type: "media";
                        mediaType: string;
                        data: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        filename?: string | undefined;
                        type: "file-data";
                        mediaType: string;
                        data: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        mediaType?: string | undefined;
                        type: "file-url";
                        url: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "file-id";
                        fileId: string | Record<string, string>;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "file-reference";
                        providerReference: Record<string, string>;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "image-data";
                        mediaType: string;
                        data: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "image-file-reference";
                        providerReference: Record<string, string>;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "image-url";
                        url: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "image-file-id";
                        fileId: string | Record<string, string>;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "custom";
                    })[];
                } | undefined;
                result?: any;
                isError?: boolean | undefined;
                experimental_content?: ({
                    type: "text";
                    text: string;
                } | {
                    mimeType?: string | undefined;
                    type: "image";
                    data: string;
                })[] | undefined;
                type: "tool-result";
                toolCallId: string;
                toolName: string;
            } | {
                title?: string | undefined;
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                id: string;
                type: "source";
                url: string;
                sourceType: "url";
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                filename?: string | undefined;
                id: string;
                title: string;
                type: "source";
                mediaType: string;
                sourceType: "document";
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                signature?: string | undefined;
                isAutomatic?: boolean | undefined;
                type: "tool-approval-request";
                toolCallId: string;
                approvalId: string;
            })[];
        } | {
            providerOptions?: Record<string, Record<string, any>> | undefined;
            role: "tool";
            content: ({
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                args?: any;
                providerExecuted?: boolean | undefined;
                output?: {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    type: "text";
                    value: string;
                } | {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    type: "json";
                    value: any;
                } | {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    type: "error-text";
                    value: string;
                } | {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    type: "error-json";
                    value: any;
                } | {
                    providerOptions?: Record<string, Record<string, any>> | undefined;
                    reason?: string | undefined;
                    type: "execution-denied";
                } | {
                    type: "content";
                    value: ({
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "text";
                        text: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        filename?: string | undefined;
                        type: "file";
                        mediaType: string;
                        data: {
                            type: "reference";
                            reference: Record<string, string>;
                        } | {
                            type: "url";
                            url: string;
                        } | {
                            type: "data";
                            data: string | ArrayBuffer;
                        } | {
                            type: "text";
                            text: string;
                        };
                    } | {
                        type: "media";
                        mediaType: string;
                        data: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        filename?: string | undefined;
                        type: "file-data";
                        mediaType: string;
                        data: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        mediaType?: string | undefined;
                        type: "file-url";
                        url: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "file-id";
                        fileId: string | Record<string, string>;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "file-reference";
                        providerReference: Record<string, string>;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "image-data";
                        mediaType: string;
                        data: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "image-file-reference";
                        providerReference: Record<string, string>;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "image-url";
                        url: string;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "image-file-id";
                        fileId: string | Record<string, string>;
                    } | {
                        providerOptions?: Record<string, Record<string, any>> | undefined;
                        type: "custom";
                    })[];
                } | undefined;
                result?: any;
                isError?: boolean | undefined;
                experimental_content?: ({
                    type: "text";
                    text: string;
                } | {
                    mimeType?: string | undefined;
                    type: "image";
                    data: string;
                })[] | undefined;
                type: "tool-result";
                toolCallId: string;
                toolName: string;
            } | {
                providerOptions?: Record<string, Record<string, any>> | undefined;
                providerMetadata?: Record<string, Record<string, any>> | undefined;
                providerExecuted?: boolean | undefined;
                reason?: string | undefined;
                type: "tool-approval-response";
                approvalId: string;
                approved: boolean;
            })[];
        } | {
            providerOptions?: Record<string, Record<string, any>> | undefined;
            role: "system";
            content: string;
        } | undefined;
        text?: string | undefined;
        providerMetadata?: Record<string, Record<string, any>> | undefined;
        reasoning?: string | undefined;
        usage?: {
            promptTokens?: number | undefined;
            completionTokens?: number | undefined;
            totalTokens?: number | undefined;
            reasoningTokens?: number | undefined;
            cachedInputTokens?: number | undefined;
            nonCachedInputTokens?: number | undefined;
            cacheWriteInputTokens?: number | undefined;
            textOutputTokens?: number | undefined;
            raw?: Record<string, any> | undefined;
        } | undefined;
        sources?: ({
            title?: string | undefined;
            type?: "source" | undefined;
            providerOptions?: Record<string, Record<string, any>> | undefined;
            providerMetadata?: Record<string, Record<string, any>> | undefined;
            id: string;
            url: string;
            sourceType: "url";
        } | {
            providerOptions?: Record<string, Record<string, any>> | undefined;
            providerMetadata?: Record<string, Record<string, any>> | undefined;
            filename?: string | undefined;
            id: string;
            title: string;
            type: "source";
            mediaType: string;
            sourceType: "document";
        })[] | undefined;
        warnings?: ({
            details?: string | undefined;
            type: "unsupported";
            feature: string;
        } | {
            details?: string | undefined;
            type: "compatibility";
            feature: string;
        } | {
            type: "deprecated";
            message: string;
            setting: string;
        } | {
            details?: string | undefined;
            type: "unsupported-setting";
            setting: string;
        } | {
            details?: string | undefined;
            type: "unsupported-tool";
            tool: any;
        } | {
            type: "other";
            message: string;
        })[] | undefined;
        finishReason?: "error" | "length" | "other" | "stop" | "content-filter" | "tool-calls" | "unknown" | undefined;
        reasoningDetails?: ({
            providerOptions?: Record<string, Record<string, any>> | undefined;
            providerMetadata?: Record<string, Record<string, any>> | undefined;
            signature?: string | undefined;
            type: "reasoning";
            text: string;
        } | {
            signature?: string | undefined;
            type: "text";
            text: string;
        } | {
            type: "redacted";
            data: string;
        })[] | undefined;
        status: "pending" | "success" | "failed";
        order: number;
        _creationTime: number;
        threadId: string;
        stepOrder: number;
        tool: boolean;
        _id: string;
    };
}>;
export {};
