import { type RuntimeContext } from "./runtime-context.js";
import type { SandboxWriteBytes } from "./types.js";
/** Accept the same trusted ToolContext as filesystem operations, or facts from a host action. */
export declare function bindWriteBytes(runtime: RuntimeContext): SandboxWriteBytes;
/** Carry a typed write error out of the Node action so the caller can restore its code. */
export declare function exportWriteError(error: unknown): unknown;
