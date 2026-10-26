/**
 * Thread-bound file reading and search tools for host/slot callers.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { type ToolSet } from "ai";
import { type RuntimeContext, type Scoped } from "./context.js";
import type { ActionCtx } from "./types.js";
/** Bind model-visible file reads and search to the server-provided thread and subject. */
export declare function tools(runtime: RuntimeContext, context: Scoped & {
    ctx: ActionCtx;
}): ToolSet;
