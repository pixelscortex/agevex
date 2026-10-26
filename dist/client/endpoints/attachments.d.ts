import { type GenericDataModel, type GenericMutationCtx } from "convex/server";
import type { ManagedAgent } from "../types.js";
import type { EndpointContext } from "./access.js";
type MutationCtx = GenericMutationCtx<GenericDataModel>;
/** At most `LIMITS.filesPerMessage` distinct, bounded file ids; else `INVALID_FILES`. */
export declare function validateFiles(files?: string[]): void;
/**
 * Validate the subject's files and build the native message to save.
 *
 * Returns `{ rejected: true }` when the files' total storage size exceeds the
 * attachment byte limit; throws `FILE_FORBIDDEN` / `INVALID_FILE` for a file the
 * subject was not granted or whose metadata is missing or oversized.
 */
export declare function attachment(ep: EndpointContext, ctx: MutationCtx, managed: ManagedAgent, subject: string, text: string, files?: string[]): Promise<{
    rejected: true;
    native?: undefined;
    message?: undefined;
    metadata?: undefined;
} | {
    native: import("convex/server").FunctionHandle<"query", {
        fileId: string;
    }, {
        _creationTime: number;
        _id: string;
        filename?: string;
        hash: string;
        lastTouchedAt: number;
        mediaType?: string;
        mimeType?: string;
        refcount: number;
        storageId: string;
    } | null>;
    message: {
        role: "user";
        content: string | (import("ai").TextPart | import("ai").ImagePart | import("ai").FilePart)[];
    };
    metadata: {
        fileIds: string[];
    };
    rejected?: undefined;
}>;
/** Bind the request's files to the saved message, when there are any. */
export declare function recordAttachments(ep: EndpointContext, ctx: MutationCtx, native: string, files: string[] | undefined, subject: string, threadId: string, messageId: string): Promise<void>;
export {};
