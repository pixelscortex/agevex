/**
 * Public host entry point for the optional sandbox component.
 * Wires validated runtime context into lifecycle, tools and watchdog builders.
 * Hosts retain authorization, provider configuration and completion callbacks.
 */
import { internalActionGeneric, } from "convex/server";
import { v } from "convex/values";
import {} from "../../../client/once.js";
import {} from "../../../client/index.js";
import { LIMITS, tail } from "../shared/limits.js";
import {} from "./types.js";
import { scopeKey, createRuntimeContext } from "./runtime-context.js";
import { prepare, jobSnapshot, scheduleCleanup, forgetSandbox, deleteSandbox, stopSandbox, } from "./lifecycle.js";
import { readFile, list } from "./files.js";
import { tools, slot } from "./tools.js";
import { internalFunctions } from "./watchdog.js";
import { exportSandbox } from "./export.js";
import { bindWriteBytes, exportWriteError } from "./write.js";
/**
 * Connect a finished background job to agevex: pass the result as
 * `defineSandbox({ onComplete: sandboxCompletion(() => runtime) })`, where
 * `runtime` is the `registerAgent` result (a thunk, because the sandbox is
 * created before the runtime that uses its slot).
 *
 * The callback runs inside the sandbox's own terminal-state transaction, so the
 * note and the job transition commit or roll back together. Core's
 * `sandboxComplete` re-authorizes the stored owner and posts a passive note
 * (delivered at the next safe turn claim). The payload is bounded here, not
 * trusted to the provider: the log keeps its tail within
 * LIMITS.completionLogChars, and an exit code outside the range core accepts is
 * dropped, because core would reject it, roll back the settlement and leave
 * the job retrying until its deadline.
 */
export function sandboxCompletion(runtime) {
    return async (ctx, event) => {
        const target = typeof runtime === "function" ? runtime() : runtime;
        // The deadline code is the one fact the model cannot infer from "unknown";
        // keep it ahead of the log tail so truncation can only cut old output.
        const header = event.code ? `[${event.code}]\n` : "";
        const log = header + tail(event.logTail ?? "", LIMITS.completionLogChars - header.length);
        await target.sandboxComplete(ctx, {
            subject: event.subject,
            threadId: event.threadId,
            runId: event.runId,
            jobId: event.jobId,
            state: event.state,
            ...(event.exitCode !== undefined &&
                Number.isSafeInteger(event.exitCode) &&
                Math.abs(event.exitCode) <= LIMITS.completionExitCodeMax
                ? { exitCode: event.exitCode }
                : {}),
            ...(log ? { logTail: log } : {}),
        });
    };
}
/**
 * Bind sandboxes to trusted request facts. Mount this optional component on its
 * own; core and the Agent component never depend on its schema. Public host
 * endpoints must call these helpers rather than exposing component references.
 */
export function defineSandbox(options) {
    return sandboxRuntime(options, false);
}
/** Export this action from a host "use node" file to opt into the 512 MiB runtime. */
export function sandboxNodeExport(options) {
    const sandbox = sandboxRuntime(options, true);
    return internalActionGeneric({
        args: { threadId: v.string(), path: v.string() },
        handler: (ctx, args) => sandbox.export(ctx, args),
    });
}
/** Export from a host "use node" file; large writes delegate using a storage id only. */
export function sandboxNodeWrite(options) {
    const sandbox = sandboxRuntime(options, true);
    return internalActionGeneric({
        args: {
            subject: v.string(),
            threadId: v.string(),
            runId: v.string(),
            path: v.string(),
            source: v.object({ storageId: v.id("_storage") }),
            maxBytes: v.optional(v.number()),
        },
        returns: v.object({ bytes: v.number(), sha256: v.string() }),
        handler: async (ctx, args) => {
            try {
                return await sandbox.writeBytes(ctx, args);
            }
            catch (error) {
                // Plain errors lose their class across ctx.runAction; ConvexError data survives.
                throw exportWriteError(error);
            }
        },
    });
}
function sandboxRuntime(options, nodeExport) {
    const runtime = createRuntimeContext(options, nodeExport);
    return {
        limits: runtime.limits,
        tools: (context) => tools(runtime, context),
        slot: () => slot(runtime),
        scopeKey: (tc) => scopeKey(runtime, tc),
        prepare: (tc, opts) => prepare(runtime, tc, opts),
        readFile: (tc, input) => readFile(runtime, tc, input),
        writeBytes: bindWriteBytes(runtime),
        list: (tc, input) => list(runtime, tc, input),
        internalFunctions: () => internalFunctions(runtime),
        job: (ctx, input) => jobSnapshot(runtime, ctx, input),
        cleanup: (ctx) => scheduleCleanup(runtime, ctx),
        forget: (ctx, input) => forgetSandbox(runtime, ctx, input),
        delete: (tc) => deleteSandbox(runtime, tc),
        stop: (tc) => stopSandbox(runtime, tc),
        export: (ctx, input) => exportSandbox(runtime, ctx, input),
    };
}
export { daytona } from "./daytona.js";
export { SandboxWriteError } from "../shared/write.js";
export { LIMITS, HARD_LIMITS } from "../shared/limits.js";
