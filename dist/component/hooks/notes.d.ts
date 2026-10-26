/**
 * Notes and staged hook continuations, from admission to native history.
 *
 * Notes are short `<note from="...">` user messages posted by hooks or the
 * host. `addNote` (`queueNote`) keeps one as a passive `inbox` row (body in
 * `text`) until a safe turn claim saves it (`claimNotes`, called by
 * turns/claim.ts), placed after the prior response and before the claimed
 * work. `beforeTurnNote` (`saveBeforeTurnNote`) saves one immediately when
 * no approval results are outstanding. `cancelNotes` (`dropCancelledNotes`)
 * deletes a cancelled epoch's unsaved bodies. Touches `inbox` and
 * `assignments`.
 */
import { type Infer } from "convex/values";
import { type MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** The native Agent handles claim needs to place notes: read the anchor, save
 * empty assistant slots, then turn each slot into the note's user message. */
export declare const noteHandles: import("convex/values").VObject<{
    getMessages: string;
    addMessages: string;
    updateMessage: string;
}, {
    getMessages: import("convex/values").VString<string, "required">;
    addMessages: import("convex/values").VString<string, "required">;
    updateMessage: import("convex/values").VString<string, "required">;
}, "required", "getMessages" | "addMessages" | "updateMessage">;
/** Called only by claim, after choosing the claimed work and before publishing
 * its running state. Posted notes never write native history anywhere else.
 * Agent 0.7.7 component/messages.ts:302-305,390-406 supports integer order,
 * but moves subsequent USER messages to a fresh order. Allocate successful
 * empty assistant slots in one batch, then finalize their user roles with
 * updateMessage (:553-597), preserving both arrival order and native positions.
 * <=24 raw rows *17 KiB read twice + six native merge heads <=6 MiB + one
 * anchor <=1 MiB +24 escaped notes *50 KiB +metadata <128 KiB: <10 MiB read,
 * <3 MiB written. A hook continuation adds <=64 KiB read/write. The bounded
 * ready-group claim uses metadata only; native heads are read just once.
 */
export declare function claimNotes(ctx: MutationCtx, row: Doc<"assignments">, handles: Infer<typeof noteHandles>, order: number, continuation?: Doc<"inbox">): Promise<void>;
/** Agent 0.7.7 client/messages.ts:132-138 forwards promptMessageId/order.
 * component/messages.ts:306-318 selects the anchor group, but :392-406 moves
 * USER messages to a fresh order even with promptMessageId. Its supported
 * numeric order option (:302-305,391-392) instead appends the first user message
 * at the next stepOrder. Both options together are rejected (:258-262).
 * Read one recorded anchor id, then save one user control with that order in
 * this same transaction. No transcript scan or read-time context adapter.
 * Exact anchor <=1 MiB + six native merge heads <=6 MiB + one save/result
 * <=130 KiB + assignment/ref metadata <128 KiB: <8 MiB <16 MiB per control.
 */
export declare function controlOrder(ctx: MutationCtx, row: Doc<"assignments">, getMessages: string): Promise<number>;
/** Save one note natively at `order` (from controlOrder) and return the doc. */
export declare function saveNote(ctx: MutationCtx, row: Doc<"assignments">, addMessages: string, order: number, text: string, from: string): Promise<{
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
}>;
/** turns.slices.write fences hook notes by execution/epoch; external notes serialize
 * against cancellation here. Every post retains only its bounded raw payload.
 * Refuses past the assignment's `notesPending` cap. */
export declare function queueNote(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    text: string;
    from: string;
}): Promise<boolean>;
/** Before-turn notes can enter history immediately only when prior approvals
 * have committed their results. Otherwise share the pending-note admission cap
 * and defer delivery to a safe claim. turns.slices.write supplies the epoch fence.
 */
export declare function saveBeforeTurnNote(ctx: MutationCtx, args: {
    assignmentId: Id<"assignments">;
    text: string;
    from: string;
    addMessages: string;
    getMessages: string;
}): Promise<void>;
/** Cancellation never loads the raw note bodies across all sixteen assignments.
 * One finite job per assignment reads/deletes <=24*17 KiB twice +32 KiB
 * assignment metadata =848 KiB (<864 KiB).
 * Pending notes have never entered Agent; delivered origin rows are excluded.
 * The epoch index fences a fresh send even when it precedes this job. Each
 * cancelled epoch has <=24 notes, so no chain or history prefix is needed.
 */
export declare function dropCancelledNotes(ctx: MutationCtx, assignmentId: Id<"assignments">, epoch: number): Promise<void>;
/** Queue a note for the next safe claim; see `queueNote`. */
export declare const addNote: import("convex/server").RegisteredMutation<"public", {
    from: string;
    text: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<boolean>>;
/** Save a beforeTurn note now, or queue it behind outstanding approval
 * results; see `saveBeforeTurnNote`. */
export declare const beforeTurnNote: import("convex/server").RegisteredMutation<"public", {
    from: string;
    text: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    getMessages: string;
    addMessages: string;
}, Promise<void>>;
/** Delete a cancelled epoch's unsaved note bodies; one finite job per
 * assignment, scheduled by turns.cancel.cancel. */
export declare const cancelNotes: import("convex/server").RegisteredMutation<"internal", {
    epoch: number;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<void>>;
