/**
 * Daytona process adapter operations.
 * The host provider factory binds these to one SDK client and validated settings.
 * Bounds are enforced inside the sandbox before data crosses Convex boundaries.
 */
import { type SandboxProvider } from "./types.js";
import { type DaytonaContext } from "./daytona-context.js";
/** Bind exec to the provider client; retain its source-side bounds and effect policy. */
export declare function buildExec(runtime: DaytonaContext): SandboxProvider["exec"];
/** Bind startBackground to the provider client; retain its source-side bounds and effect policy. */
export declare function buildStartBackground(runtime: DaytonaContext): SandboxProvider["startBackground"];
/** Bind poll to the provider client; retain its source-side bounds and effect policy. */
export declare function buildPoll(runtime: DaytonaContext): SandboxProvider["poll"];
/** Bind cancelBackground to the provider client; retain its source-side bounds and effect policy. */
export declare function buildCancelBackground(runtime: DaytonaContext): SandboxProvider["cancelBackground"];
