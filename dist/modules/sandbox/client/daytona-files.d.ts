/**
 * Daytona files adapter operations.
 * The host provider factory binds these to one SDK client and validated settings.
 * Bounds are enforced inside the sandbox before data crosses Convex boundaries.
 */
import { type SandboxProvider } from "./types.js";
import { type DaytonaContext } from "./daytona-context.js";
/** Bind readFile to the provider client; retain its source-side bounds and effect policy. */
export declare function buildReadFile(runtime: DaytonaContext): SandboxProvider["readFile"];
/** Bind writeFile to the provider client; retain its source-side bounds and effect policy. */
export declare function buildWriteFile(runtime: DaytonaContext): SandboxProvider["writeFile"];
/** Bind listFiles to the provider client; retain its source-side bounds and effect policy. */
export declare function buildListFiles(runtime: DaytonaContext): SandboxProvider["listFiles"];
/** Bind upload to the provider client; retain its source-side bounds and effect policy. */
export declare function buildUpload(runtime: DaytonaContext): SandboxProvider["upload"];
/** Bind download to the provider client; retain its source-side bounds and effect policy. */
export declare function buildDownload(runtime: DaytonaContext): SandboxProvider["download"];
