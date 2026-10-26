/**
 * Public EXTRACT entry points and runtime composition.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { internalActionGeneric } from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { extractSlot } from "./adapter.js";
import { purge, release } from "./cleanup.js";
import { bindRuntime, resolveRuntime } from "./context.js";
import { fromUrl, get, run } from "./files.js";
import { index } from "./indexing.js";
import { readPages, readText, readWindow } from "./reads.js";
import { internalFunctions } from "./registrations.js";
import { search } from "./search.js";
import { tools } from "./tools.js";
import type { ActionCtx, ExtractOptions, NodeReadArgs } from "./types.js";

export type { ComponentApi } from "../component/_generated/component.js";
export { LIMITS } from "../shared/limits.js";
export { authorizeAttached } from "./adapter.js";
export { directText, ExtractError, firecrawlParse, visionOcr } from "./backends.js";
export type {
  BackendInput,
  BackendResult,
  ExtractBackend,
  ExtractedDoc,
  ExtractFailure,
  ExtractOptions,
  FileInfo,
  NodeReadArgs,
  Page,
  ProviderUsage,
  Scope,
  WorkerArgs,
} from "./types.js";

/**
 * Standalone host helper. Export internalFunctions().execute as the worker
 * reference supplied here; only the component can create a valid dispatch
 * claim. Public host wrappers call these methods with the owning thread.
 */
export function defineExtract(component: ComponentApi, options: ExtractOptions) {
  return extractRuntime(component, options, false);
}

/**
 * Opt-in Node variant, exported from a host file beginning with "use node"
 * (512 MiB instead of 64 MiB):
 *
 * ```ts
 * "use node";
 * export const { execute, read } = extractNodeExport(components.agevexExtract, extractOptions);
 * ```
 *
 * Register those two references as `options.node` of `defineExtract`. Files
 * above the default byte ceilings are then extracted by `execute`, and
 * payloads above the default read ceiling are windowed by `read`; both repeat
 * authorization. See LIMITS for the memory arithmetic behind each runtime.
 */
export function extractNodeExport(component: ComponentApi, options: ExtractOptions) {
  const runtime = extractRuntime(component, options, true);

  return {
    execute: runtime.internalFunctions().execute,
    read: internalActionGeneric({
      args: {
        kind: v.union(v.literal("text"), v.literal("pages")),
        threadId: v.string(),
        subject: v.optional(v.string()),
        artifactId: v.string(),
        cursor: v.optional(v.number()),
        maxBytes: v.optional(v.number()),
        from: v.optional(v.number()),
        count: v.optional(v.number()),
      },
      handler: (ctx, args) => runtime.nodeRead(ctx, args as NodeReadArgs),
    }),
  };
}

/** Compose host methods around one explicitly resolved configuration. */
function extractRuntime(component: ComponentApi, options: ExtractOptions, nodeRuntime: boolean) {
  const runtime = resolveRuntime(component, options, nodeRuntime);

  const api = {
    run: bindRuntime(runtime, run),
    get: bindRuntime(runtime, get),
    fromUrl: bindRuntime(runtime, fromUrl),
    release: bindRuntime(runtime, release),
    purge: bindRuntime(runtime, purge),
    readText: bindRuntime(runtime, readText),
    readPages: bindRuntime(runtime, readPages),
    index: bindRuntime(runtime, index),
    search: bindRuntime(runtime, search),
    tools: bindRuntime(runtime, tools),
    internalFunctions: () => internalFunctions(runtime),
    /** The Node runtime's authorized windowed read; see extractNodeExport. */
    nodeRead: (ctx: ActionCtx, request: NodeReadArgs) => readWindow(runtime, ctx, request),
    /**
     * The agevex extract slot: core admits each attached file at the first slice
     * and binds tools to the running thread and subject (see adapter.ts).
     * search_files is offered only with autoIndex so the namespace gets filled.
     */
    slot: () => extractSlot(api, !!options.autoIndex),
  };

  return api;
}
