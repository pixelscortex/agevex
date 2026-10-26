/**
 * Public host entry point for the optional sandbox component.
 * Wires validated runtime context into lifecycle, tools and watchdog builders.
 * Hosts retain authorization, provider configuration and completion callbacks.
 */
import {
  internalActionGeneric,
  type GenericMutationCtx,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";
import { type ToolContext } from "../../../client/once.js";
import { type SandboxCompletion } from "../../../client/index.js";
import { LIMITS, tail } from "../shared/limits.js";
import {
  type SandboxCall,
  type SandboxContext,
  type SandboxFacts,
  type SandboxOptions,
  type PollArgs,
  type SandboxExportArgs,
  type SandboxExportResult,
} from "./types.js";
import { scopeKey, createRuntimeContext } from "./runtime-context.js";
import {
  prepare,
  jobSnapshot,
  scheduleCleanup,
  forgetSandbox,
  deleteSandbox,
  stopSandbox,
} from "./lifecycle.js";
import { readFile, list } from "./files.js";
import { tools, slot } from "./tools.js";
import { internalFunctions } from "./watchdog.js";
import { exportSandbox } from "./export.js";
import { bindWriteBytes } from "./write.js";

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
export function sandboxCompletion(
  runtime:
    | {
        sandboxComplete(
          ctx: GenericMutationCtx<GenericDataModel>,
          event: SandboxCompletion,
        ): unknown;
      }
    | (() => {
        sandboxComplete(
          ctx: GenericMutationCtx<GenericDataModel>,
          event: SandboxCompletion,
        ): unknown;
      }),
): NonNullable<SandboxOptions["onComplete"]> {
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
export function defineSandbox(options: SandboxOptions) {
  return sandboxRuntime(options, false);
}

/** Export this action from a host "use node" file to opt into the 512 MiB runtime. */
export function sandboxNodeExport(options: SandboxOptions) {
  const sandbox = sandboxRuntime(options, true);

  return internalActionGeneric({
    args: { threadId: v.string(), path: v.string() },
    handler: (ctx, args): Promise<SandboxExportResult> => sandbox.export(ctx, args),
  });
}

/** Export from a host "use node" file; large writes delegate using a storage id only. */
export function sandboxNodeWrite(options: SandboxOptions) {
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
    handler: (ctx, args) => sandbox.writeBytes(ctx, args),
  });
}

function sandboxRuntime(options: SandboxOptions, nodeExport: boolean) {
  const runtime = createRuntimeContext(options, nodeExport);

  return {
    limits: runtime.limits,
    tools: (context?: ToolContext) => tools(runtime, context),
    slot: () => slot(runtime),
    scopeKey: (tc: SandboxFacts) => scopeKey(runtime, tc),
    prepare: (tc: SandboxCall, opts?: { existingOnly?: boolean }) => prepare(runtime, tc, opts),
    readFile: (tc: SandboxCall, input: { path: string }) => readFile(runtime, tc, input),
    writeBytes: bindWriteBytes(runtime),
    list: (tc: SandboxCall, input: { path: string }) => list(runtime, tc, input),
    internalFunctions: () => internalFunctions(runtime),
    job: (ctx: SandboxContext, input: PollArgs) => jobSnapshot(runtime, ctx, input),
    cleanup: (ctx: SandboxContext) => scheduleCleanup(runtime, ctx),
    forget: (ctx: SandboxContext, input: SandboxFacts) => forgetSandbox(runtime, ctx, input),
    delete: (tc: SandboxCall) => deleteSandbox(runtime, tc),
    stop: (tc: SandboxCall) => stopSandbox(runtime, tc),
    export: (ctx: SandboxContext, input: SandboxExportArgs) => exportSandbox(runtime, ctx, input),
  };
}

export { daytona } from "./daytona.js";
export { SandboxWriteError } from "../shared/write.js";
export type { SandboxWriteErrorCode } from "../shared/write.js";
export type { Credential } from "./credential.js";
export { LIMITS, HARD_LIMITS } from "../shared/limits.js";
export type { SandboxLimits } from "../shared/limits.js";
export type * from "./types.js";
export type { ComponentApi } from "../component/_generated/component.js";
