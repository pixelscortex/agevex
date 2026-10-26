/**
 * Daytona lifecycle adapter operations.
 * The host provider factory binds these to one SDK client and validated settings.
 * Bounds are enforced inside the sandbox before data crosses Convex boundaries.
 */
import { type SandboxProvider } from "./types.js";
import { type DaytonaContext } from "./daytona-context.js";
/** Bind create to the provider client; retain its source-side bounds and effect policy. */
export declare function buildCreate(runtime: DaytonaContext): SandboxProvider["create"];
/** Bind resume to the provider client; retain its source-side bounds and effect policy. */
export declare function buildResume(runtime: DaytonaContext): SandboxProvider["resume"];
/** Bind stop to the provider client; retain its source-side bounds and effect policy. */
export declare function buildStop(runtime: DaytonaContext): SandboxProvider["stop"];
/** Bind delete to the provider client; retain its source-side bounds and effect policy. */
export declare function buildDelete(runtime: DaytonaContext): SandboxProvider["delete"];
