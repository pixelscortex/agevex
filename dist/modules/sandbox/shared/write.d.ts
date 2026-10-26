declare const WRITE_ERROR_CODES: readonly ["SANDBOX_WRITE_TOO_LARGE", "SANDBOX_WRITE_OFFSET_MISMATCH", "SANDBOX_WRITE_INCOMPLETE"];
export type SandboxWriteErrorCode = (typeof WRITE_ERROR_CODES)[number];
/** Narrow untrusted error data (for example from another action) to a stable code. */
export declare function isWriteErrorCode(value: unknown): value is SandboxWriteErrorCode;
/** Preserve a machine-readable code for direct host/provider callers. */
export declare class SandboxWriteError extends Error {
    readonly code: SandboxWriteErrorCode;
    constructor(code: SandboxWriteErrorCode);
}
/** Every provider crossing carries at most one window, even in the Node runtime. */
export declare function validateWriteWindow(path: string, offset: number, bytes: Uint8Array): void;
/** Commit metadata is constant size; the provider hashes with bounded filesystem reads. */
export declare function validateWriteCommit(tempPath: string, path: string, bytes: number, sha256: string): void;
export {};
