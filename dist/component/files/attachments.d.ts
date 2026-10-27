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
    subject: string;
    threadId: string;
    messageId: string;
    native: string;
    files: string[];
}, Promise<null>>;
/** The file ids bound to one message of this subject's thread. */
export declare const forMessage: import("convex/server").RegisteredQuery<"public", {
    subject: string;
    threadId: string;
    messageId: string;
    native: string;
}, Promise<string[]>>;
