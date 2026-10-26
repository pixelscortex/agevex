/**
 * Daytona binary stages use the SDK's binary upload plus bounded Python filesystem operations.
 * Commands contain paths/metadata only; bytes never enter execution stdout or command records.
 */
import type { SandboxProvider } from "./types.js";
import { type DaytonaContext } from "./daytona-context.js";
/** Stage one window with offset checking; exact duplicates never append twice. */
export declare function buildWriteWindow(runtime: DaytonaContext): SandboxProvider["writeWindow"];
/**
 * Hash bounded windows before atomic rename; a wrong size/hash can never replace the target.
 * The stage is created 0666 so the sandbox umask decides a new file's mode; an existing
 * regular target keeps its permission bits (the rename would otherwise drop them).
 */
export declare function buildCommitWrite(runtime: DaytonaContext): SandboxProvider["commitWrite"];
/** Idempotent cleanup reclaims both interrupted SDK uploads and incomplete stages. */
export declare function buildDiscardWrite(runtime: DaytonaContext): SandboxProvider["discardWrite"];
/** Sweep stale abandoned stages of one path without touching a live attempt's fresh files. */
export declare function buildReclaimWrites(runtime: DaytonaContext): SandboxProvider["reclaimWrites"];
