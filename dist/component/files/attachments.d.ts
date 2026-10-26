/**
 * Attachment attestations in the `receipts` table (`kind: "attachment"`):
 * upload grants and message bindings.
 *
 * Two row shapes share one kind: an upload *grant* (no `threadId`) proves a
 * subject uploaded a native file, written by the host's trusted upload
 * transaction (`register`); a message *binding* (with `threadId` and
 * `messageId`) records that a file was attached to one exact native message,
 * written atomically with that message (`attach` -> `bindFiles`). The host
 * checks `owns` / `forMessage` before a model reads an attachment. All reads
 * are exact `by_file` / `by_message` lookups capped at
 * `LIMITS.filesPerMessage`. Native Agent still owns file bytes and metadata.
 */
import { type MutationCtx, type QueryCtx } from "../_generated/server.js";
/** File and message ids are bounded opaque identities. */
export declare function assertFileIdentity(value: string): void;
/** The native component handle namespaces every file id. */
export declare function assertNativeHandle(value: string): void;
/** The subject's upload grant for one native file, or null. */
export declare function uploadGrant(ctx: Pick<QueryCtx, "db">, native: string, fileId: string, subject: string): Promise<{
    _id: import("convex/values").GenericId<"receipts">;
    _creationTime: number;
    result?: any;
    claim?: string | undefined;
    leaseUntil?: number | undefined;
    kind: "effect";
    status: "failed" | "running" | "done" | "unknown";
    key: string;
    scope: string;
    fingerprint: string;
    expiresAt: number;
} | {
    _id: import("convex/values").GenericId<"receipts">;
    _creationTime: number;
    threadId?: string | undefined;
    messageId?: string | undefined;
    kind: "attachment";
    subject: string;
    native: string;
    fileId: string;
} | null>;
/** Every binding of one native message (never more than filesPerMessage). */
export declare function messageBindings(ctx: Pick<QueryCtx, "db">, native: string, messageId: string): Promise<({
    _id: import("convex/values").GenericId<"receipts">;
    _creationTime: number;
    result?: any;
    claim?: string | undefined;
    leaseUntil?: number | undefined;
    kind: "effect";
    status: "failed" | "running" | "done" | "unknown";
    key: string;
    scope: string;
    fingerprint: string;
    expiresAt: number;
} | {
    _id: import("convex/values").GenericId<"receipts">;
    _creationTime: number;
    threadId?: string | undefined;
    messageId?: string | undefined;
    kind: "attachment";
    subject: string;
    native: string;
    fileId: string;
})[]>;
/** Bind granted files to one native message in the transaction that saves
 * it. Refuses more than `filesPerMessage` bindings per message (across
 * repeated calls) and any file the subject holds no grant for; re-binding an
 * already bound file is a no-op. */
export declare function bindFiles(ctx: MutationCtx, args: {
    native: string;
    files: string[];
    subject: string;
    threadId: string;
    messageId: string;
}): Promise<null>;
/** Host-only upload attestation, not a browser endpoint. The host must call
 * this from its trusted upload transaction, never expose arbitrary file ids as
 * proof of ownership. Agent 0.7.7 files.ts:22-83 has hash dedup but no subject. */
export declare const register: import("convex/server").RegisteredMutation<"public", {
    subject: string;
    native: string;
    fileId: string;
}, Promise<null>>;
/** Whether the subject holds a grant (no `threadId`) or a binding in that
 * thread for one native file. */
export declare const owns: import("convex/server").RegisteredQuery<"public", {
    threadId?: string | undefined;
    subject: string;
    native: string;
    fileId: string;
}, Promise<boolean>>;
/** Bind granted files to one native message; see `bindFiles`. */
export declare const attach: import("convex/server").RegisteredMutation<"public", {
    threadId: string;
    subject: string;
    messageId: string;
    native: string;
    files: string[];
}, Promise<null>>;
/** The file ids bound to one message of this subject's thread. */
export declare const forMessage: import("convex/server").RegisteredQuery<"public", {
    threadId: string;
    subject: string;
    messageId: string;
    native: string;
}, Promise<string[]>>;
