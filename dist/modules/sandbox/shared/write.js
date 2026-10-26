/** Stable binary-write errors and source-side bounds shared by real and fake providers. */
import { HARD_LIMITS, LIMITS, bounded, integer } from "./limits.js";
const WRITE_ERROR_CODES = [
    "SANDBOX_WRITE_TOO_LARGE",
    "SANDBOX_WRITE_OFFSET_MISMATCH",
    "SANDBOX_WRITE_INCOMPLETE",
];
/** Narrow untrusted error data (for example from another action) to a stable code. */
export function isWriteErrorCode(value) {
    return WRITE_ERROR_CODES.includes(value);
}
/** Preserve a machine-readable code for direct host/provider callers. */
export class SandboxWriteError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "SandboxWriteError";
    }
}
/** Every provider crossing carries at most one window, even in the Node runtime. */
export function validateWriteWindow(path, offset, bytes) {
    bounded(path, LIMITS.pathChars, "PATH");
    integer(offset, HARD_LIMITS.exportBytesNode, "WRITE_OFFSET", 0);
    if (bytes.byteLength > LIMITS.exportChunkBytes ||
        offset + bytes.byteLength > HARD_LIMITS.exportBytesNode)
        throw new SandboxWriteError("SANDBOX_WRITE_TOO_LARGE");
}
/** Commit metadata is constant size; the provider hashes with bounded filesystem reads. */
export function validateWriteCommit(tempPath, path, bytes, sha256) {
    bounded(tempPath, LIMITS.pathChars, "PATH");
    bounded(path, LIMITS.pathChars, "PATH");
    integer(bytes, HARD_LIMITS.exportBytesNode, "WRITE_SIZE", 0);
    if (!/^[a-f0-9]{64}$/.test(sha256) || tempPath === path)
        throw new Error("SANDBOX_INVALID_WRITE_COMMIT");
}
