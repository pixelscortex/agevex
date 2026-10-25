import { storeFile } from "@convex-dev/agent";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { tool, type ToolExecutionOptions } from "ai";
import {
  createFunctionHandle,
  internalActionGeneric,
  internalMutationGeneric,
  type GenericMutationCtx,
  type GenericDataModel,
} from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import { defineOnceTool, fingerprint, type ToolContext } from "../client/once.js";
import type { SandboxSlot } from "../client/slots.js";
import type { SandboxCompletion } from "../client/index.js";
import { LIMITS, bounded, integer, resolveLimits, tail } from "./limits.js";
import type {
  SandboxCall,
  SandboxContext,
  SandboxFacts,
  SandboxOptions,
  SandboxAuthorization,
  SandboxUsageEvent,
  SandboxJobEvent,
  PollArgs,
  SettleArgs,
  SandboxExportArgs,
  SandboxExportResult,
} from "./types.js";

export { daytona } from "./daytona.js";
export { LIMITS, HARD_LIMITS } from "./limits.js";
export type { SandboxLimits } from "./limits.js";
export type * from "./types.js";
export type { ComponentApi } from "./component/_generated/component.js";

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

function sandboxRuntime(options: SandboxOptions, nodeExport: boolean) {
  const limits = resolveLimits(options.limits);
  const { component, provider } = options;
  bounded(provider.id, LIMITS.providerChars, "PROVIDER");
  if (!["thread", "run", "subject"].includes(options.scope))
    throw new Error("SANDBOX_INVALID_SCOPE");
  if (typeof options.authorize !== "function") throw new Error("SANDBOX_AUTHORIZATION_REQUIRED");
  const deadlines = new WeakMap<SandboxContext, number>();

  function remaining(ctx: SandboxContext) {
    let deadline = deadlines.get(ctx);
    if (deadline === undefined) {
      deadline = Date.now() + LIMITS.actionBudgetMs;
      deadlines.set(ctx, deadline);
    }
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("SANDBOX_ACTION_DEADLINE");
    return ms;
  }

  /** One shared <=540 s budget, leaving 60 s below Convex's action ceiling. */
  async function within<T>(
    ctx: SandboxContext,
    invoke: () => Promise<T>,
    budgetMs?: number,
  ): Promise<T> {
    const ms = Math.min(remaining(ctx), budgetMs ?? LIMITS.actionBudgetMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        invoke(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("SANDBOX_ACTION_DEADLINE")), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A separate finite kill budget survives an exhausted poll/action deadline. */
  async function kill(
    ctx: SandboxContext,
    jobId: string,
    location: Parameters<typeof provider.cancelBackground>[2],
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        provider.cancelBackground(ctx, jobId, location),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("SANDBOX_KILL_DEADLINE")),
            LIMITS.backgroundKillBudgetMs,
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function facts(tc: SandboxFacts) {
    for (const key of ["subject", "threadId", "runId"] as const)
      bounded(tc[key], LIMITS.identityChars, key);
    return { subject: tc.subject, threadId: tc.threadId, runId: tc.runId };
  }

  /** Stable subject-isolated key; request bodies and model arguments are never part of binding. */
  async function scopeKey(tc: SandboxFacts) {
    const trusted = facts(tc);
    // Subject is part of every key. Sharing a thread/run identifier across
    // tenants can never attach one tenant to another tenant's sandbox.
    return fingerprint([
      options.scope,
      trusted.subject,
      options.scope === "subject"
        ? trusted.subject
        : options.scope === "thread"
          ? trusted.threadId
          : trusted.runId,
    ]);
  }

  async function authorize(
    ctx: SandboxContext | GenericMutationCtx<GenericDataModel>,
    request: SandboxAuthorization,
  ) {
    const principal = await options.authorize(ctx, request);
    bounded(principal.subject, LIMITS.identityChars, "SUBJECT");
    if (request.subject !== undefined && principal.subject !== request.subject)
      throw new Error("SANDBOX_FORBIDDEN");
    return principal;
  }

  async function observe(
    ctx: SandboxContext,
    sandboxId: string | undefined,
    operation: SandboxUsageEvent["operation"],
    outcome: SandboxUsageEvent["outcome"],
    tc?: SandboxFacts,
  ) {
    // Observability cannot turn an acknowledged effect into a failure. There
    // is deliberately no zero-cost claim: Daytona observations are estimates.
    try {
      await options.usage?.record(ctx, {
        ...(tc ? facts(tc) : {}),
        provider: provider.id,
        ...(sandboxId ? { sandboxId } : {}),
        ...(tc ? { scopeKey: await scopeKey(tc) } : {}),
        operation,
        outcome,
        source: "estimate",
        at: Date.now(),
      });
    } catch {
      /* Host accounting is independent of provider success. */
    }
  }

  /** Reserve once, save the provider id, then resume within the shared action deadline. */
  async function prepare(tc: SandboxCall) {
    tc.signal.throwIfAborted();
    remaining(tc.ctx);
    const trusted = facts(tc);
    const key = await scopeKey(tc);
    await authorize(tc.ctx, { operation: "use", scopeKey: key, ...trusted });
    const reservation = await tc.ctx.runMutation(component.state.reserve, {
      scopeKey: key,
      provider: provider.id,
      ttl: limits.ttl,
    });
    if (reservation.status === "running" || reservation.status === "unknown")
      throw new Error(`SANDBOX_${reservation.status.toUpperCase()}`);
    if (!reservation.claim) throw new Error("SANDBOX_INVALID_RESERVATION");
    const claim = reservation.claim;
    let sandboxId = reservation.status === "existing" ? reservation.sandboxId : undefined;
    try {
      if (!sandboxId) {
        const created = await within(tc.ctx, () => provider.create(tc.ctx, { scopeKey: key }));
        sandboxId = bounded(created.sandboxId, LIMITS.identityChars, "ID");
        // This MUST commit before resume/wait: a cold-start timeout must not
        // lose the only identity of the paid resource and its filesystem.
        if (
          !(await tc.ctx.runMutation(component.state.save, {
            scopeKey: key,
            claim,
            sandboxId,
            state: "creating",
          }))
        )
          throw new Error("SANDBOX_STALE");
        await observe(tc.ctx, sandboxId, "create", "observed", tc);
      }
      tc.signal.throwIfAborted();
      await within(tc.ctx, () => provider.resume(tc.ctx, sandboxId!));
      tc.signal.throwIfAborted();
      await authorize(tc.ctx, { operation: "use", scopeKey: key, ...trusted });
      if (
        !(await tc.ctx.runMutation(component.state.save, {
          scopeKey: key,
          claim,
          sandboxId,
          state: "ready",
        }))
      )
        throw new Error("SANDBOX_STALE");
      await observe(tc.ctx, sandboxId, "resume", "observed", tc);
      return { sandboxId, scopeKey: key, claim };
    } catch (error) {
      await tc.ctx.runMutation(component.state.save, {
        scopeKey: key,
        claim,
        ...(sandboxId ? { sandboxId } : {}),
        state: "unknown",
      });
      await observe(tc.ctx, sandboxId, sandboxId ? "resume" : "create", "unknown", tc);
      throw error;
    }
  }

  async function exec(tc: SandboxCall, input: { command: string }) {
    bounded(input.command, LIMITS.commandChars, "COMMAND");
    const binding = await prepare(tc);
    const timeoutS = Math.min(
      limits.commandTimeoutS,
      Math.floor(remaining(tc.ctx) / LIMITS.millisecondsPerSecond),
    );
    if (timeoutS < 1) throw new Error("SANDBOX_ACTION_DEADLINE");
    tc.signal.throwIfAborted();
    try {
      const result = await within(tc.ctx, () =>
        provider.exec(tc.ctx, binding.sandboxId, input.command, { timeoutS, signal: tc.signal }),
      );
      if (!Number.isSafeInteger(result.exitCode)) throw new Error("SANDBOX_INVALID_EXIT_CODE");
      tc.signal.throwIfAborted();
      // stdout and stderr share the allowance so even all-four-byte Unicode
      // fits core's receipt. Prefer diagnostic stderr when both overflow.
      const stderr = tail(result.stderr, limits.outputChars);
      const stdout =
        limits.outputChars > stderr.length
          ? tail(result.stdout, limits.outputChars - stderr.length)
          : "";
      await observe(tc.ctx, binding.sandboxId, "exec", "observed", tc);
      return {
        status: "done" as const,
        exitCode: result.exitCode,
        stdout,
        stderr,
        truncated: stdout.length < result.stdout.length || stderr.length < result.stderr.length,
      };
    } catch {
      await observe(tc.ctx, binding.sandboxId, "exec", "unknown", tc);
      return { status: "unknown" as const };
    }
  }

  /** Read a bounded tail without copying file content into a receipt or module row. */
  async function readFile(tc: SandboxCall, input: { path: string }) {
    bounded(input.path, LIMITS.pathChars, "PATH");
    const { sandboxId } = await prepare(tc);
    const content = await within(tc.ctx, () =>
      provider.readFile(tc.ctx, sandboxId, input.path, {
        maxBytes: limits.fileReadChars * LIMITS.utf8BytesPerChar,
      }),
    );
    tc.signal.throwIfAborted();
    return { content: tail(content, limits.fileReadChars) };
  }

  async function writeFile(tc: SandboxCall, input: { path: string; content: string }) {
    bounded(input.path, LIMITS.pathChars, "PATH");
    if (typeof input.content !== "string" || input.content.length > limits.writeChars)
      throw new Error("SANDBOX_WRITE_TOO_LARGE");
    const { sandboxId } = await prepare(tc);
    tc.signal.throwIfAborted();
    try {
      await within(tc.ctx, () => provider.writeFile(tc.ctx, sandboxId, input.path, input.content));
      tc.signal.throwIfAborted();
      await observe(tc.ctx, sandboxId, "write", "observed", tc);
      return { status: "done" as const };
    } catch {
      await observe(tc.ctx, sandboxId, "write", "unknown", tc);
      return { status: "unknown" as const };
    }
  }

  /** Return at most the registered entry count, with bounded names and finite sizes. */
  async function list(tc: SandboxCall, input: { path: string }) {
    bounded(input.path, LIMITS.pathChars, "PATH");
    const { sandboxId } = await prepare(tc);
    const entries = await within(tc.ctx, () =>
      provider.listFiles(tc.ctx, sandboxId, input.path, { limit: limits.listEntries }),
    );
    tc.signal.throwIfAborted();
    return {
      entries: entries.slice(0, limits.listEntries).map((entry) => ({
        name: bounded(entry.name, LIMITS.pathChars, "FILENAME"),
        isDir: Boolean(entry.isDir),
        ...(entry.size === undefined
          ? {}
          : { size: integer(entry.size, Number.MAX_SAFE_INTEGER, "FILE_SIZE", 0) }),
      })),
    };
  }

  async function background(tc: SandboxCall, input: { command: string }) {
    bounded(input.command, LIMITS.commandChars, "COMMAND");
    if (!options.refs) throw new Error("SANDBOX_REFS_REQUIRED");
    const { sandboxId, scopeKey: key } = await prepare(tc);
    const admitted = await tc.ctx.runMutation(component.state.reserveJob, {
      scopeKey: key,
      ...facts(tc),
      pollHandle: await createFunctionHandle(options.refs.poll()),
      pollMinMs: limits.pollMinMs,
      pollMaxMs: limits.pollMaxMs,
      jobTimeoutMs: limits.jobTimeoutMs,
      maximum: limits.jobsPerSandbox,
    });
    const admission = { jobId: admitted.jobId, claim: admitted.claim };
    try {
      tc.signal.throwIfAborted();
      const launched = await within(tc.ctx, () =>
        provider.startBackground(tc.ctx, sandboxId, input.command, {
          jobId: admitted.providerJobId,
          sandboxId,
          directory: admitted.directory,
        }),
      );
      if (
        !(await tc.ctx.runMutation(component.state.attachJob, {
          ...admission,
          providerJobId: launched.jobId,
        }))
      )
        throw new Error("SANDBOX_STALE_JOB");
      await observe(tc.ctx, sandboxId, "background", "observed", tc);
      return { status: "running" as const, jobId: admitted.jobId };
    } catch {
      const cancelled = await kill(tc.ctx, admitted.providerJobId, admitted);
      try {
        // An uncertain cancellation keeps the persisted deadline watchdog.
        // It can kill again, but can never replay the original launch.
        if (cancelled)
          await tc.ctx.runMutation(options.refs.settle(), { ...admission, state: "unknown" });
      } catch {
        // The reservation's persisted watchdog retries the atomic callback
        // within its deadline. Its failure cannot replace an uncertain paid
        // launch with TOOL_FAILED or discard the only reconciliation id.
      }
      await observe(tc.ctx, sandboxId, "background", "unknown", tc);
      return { status: "unknown" as const, jobId: admitted.jobId };
    }
  }

  /**
   * Plain SDK tools. Effects are bound by core's defineOnceTool ledger. Pure
   * reads accept trusted AI SDK `context` (or an explicit host ToolContext),
   * avoiding storing up to 640 KiB of file text in a 64 KiB receipt.
   *
   * `bind` chooses which trusted facts key the sandbox. It runs on every
   * ToolContext the tools see (once-tool body, key function and read
   * context), so no code path can reach a sandbox through unbound facts.
   */
  function buildTools(context: ToolContext | undefined, bind: (tc: ToolContext) => ToolContext) {
    const key = (_input: unknown, tc: ToolContext) => {
      // Validate attribution before core constructs a receipt scope, rather
      // than waiting until the effect body after admission has already written.
      facts(bind(tc));
      return bounded(tc.toolCallId, LIMITS.identityChars, "TOOL_CALL_ID");
    };
    const path = z
      .string()
      .min(1)
      .max(LIMITS.pathChars)
      .refine((value) => !value.includes("\0"));
    const command = z
      .string()
      .min(1)
      .max(LIMITS.commandChars)
      .refine((value) => !value.includes("\0"));
    const readContext = (opts: ToolExecutionOptions<unknown>) => {
      const tc = context ?? (opts.context as ToolContext | undefined);
      if (!tc?.ctx || !tc.signal) throw new Error("MANAGED_TOOL_CONTEXT_REQUIRED");
      return bind({ ...tc, toolCallId: opts.toolCallId });
    };
    return {
      sandbox_exec: defineOnceTool({
        name: "sandbox_exec",
        description: `Run one shell command in your sandbox; returns the exit code and the last ${limits.outputChars} characters of output (timeout ${limits.commandTimeoutS}s).`,
        key,
        input: z.object({ command }),
        run: (input, tc) => exec(bind(tc), input),
      }),
      sandbox_read_file: tool({
        description: `Read a text file from your sandbox; only the last ${limits.fileReadChars} characters are returned.`,
        inputSchema: z.object({ path }),
        execute: (input, opts) => readFile(readContext(opts), input),
      }),
      sandbox_write_file: defineOnceTool({
        name: "sandbox_write_file",
        description: `Write a text file in your sandbox, replacing it if it exists (at most ${limits.writeChars} characters).`,
        key,
        input: z.object({ path, content: z.string().max(limits.writeChars) }),
        run: (input, tc) => writeFile(bind(tc), input),
      }),
      sandbox_list: tool({
        description: `List a directory in your sandbox (name, isDir, size); at most ${limits.listEntries} entries.`,
        inputSchema: z.object({ path }),
        execute: (input, opts) => list(readContext(opts), input),
      }),
      sandbox_run_background: defineOnceTool({
        name: "sandbox_run_background",
        description:
          "Start a long-running shell command in your sandbox and return a job id at once; you are notified when it finishes, with its exit code and the end of its log.",
        key,
        input: z.object({ command }),
        run: (input, tc) => background(bind(tc), input),
      }),
    };
  }

  /** Standalone tools: the sandbox is keyed by the facts exactly as supplied. */
  function tools(context?: ToolContext) {
    return buildTools(context, (tc) => tc);
  }

  /**
   * The agevex sandbox slot (`registerAgent({ sandbox: sandbox.slot() })`).
   *
   * Core calls `tools(context)` once per turn slice with that turn's trusted
   * ToolContext; managed once-tools are then bound by core to the same facts.
   * The sandbox is keyed by `rootThreadId` instead of the acting `threadId`:
   * a delegated child runs on its own thread, but it works in its parent
   * conversation's sandbox, and a background-job completion must name a thread
   * that core's `sandboxComplete` can post a note to (the root conversation the
   * user and the root agent are in). `subject` stays in every scope key, so one
   * subject can never address another's sandbox, whatever the model sends.
   */
  function slot(): SandboxSlot {
    return {
      tools: (context) => buildTools(context, (tc) => ({ ...tc, threadId: tc.rootThreadId })),
    };
  }

  /** True while at least `minMs` of this action's shared budget remains. */
  function hasBudget(ctx: SandboxContext, minMs: number) {
    try {
      return remaining(ctx) >= minMs;
    } catch {
      return false;
    }
  }

  /**
   * Returns "deferred" when the action budget is too short to finish a delete.
   * Checked BEFORE claimDelete: a claimed delete that then times out is
   * recorded as unknown, which would strand a healthy idle sandbox. A deferred
   * row is untouched and the next sweep (with a fresh budget) takes it.
   */
  async function remove(ctx: SandboxContext, key: string, expiredOnly: boolean) {
    await authorize(ctx, { operation: "delete", scopeKey: key });
    if (!hasBudget(ctx, LIMITS.deleteMinBudgetMs)) {
      if (!expiredOnly) throw new Error("SANDBOX_ACTION_DEADLINE");
      return "deferred" as const;
    }
    const binding = await ctx.runMutation(component.state.claimDelete, {
      scopeKey: key,
      expiredOnly,
    });
    if (!binding) return "done" as const;
    try {
      await within(ctx, () => provider.delete(ctx, binding.sandboxId));
      await ctx.runMutation(component.state.save, { scopeKey: key, ...binding, state: "deleted" });
      await observe(ctx, binding.sandboxId, "delete", "observed");
    } catch {
      await ctx.runMutation(component.state.save, { scopeKey: key, ...binding, state: "unknown" });
      await observe(ctx, binding.sandboxId, "delete", "unknown");
    }
    return "done" as const;
  }

  /** Internal host actions retain provider configuration in code, never scheduled args. */
  function internalFunctions() {
    const poll = internalActionGeneric({
      args: { jobId: v.string() },
      returns: v.null(),
      handler: async (ctx, args: PollArgs): Promise<null> => {
        if (!options.refs) throw new Error("SANDBOX_REFS_REQUIRED");
        const known = await ctx.runQuery(component.state.getJob, args);
        if (!known || !["starting", "running"].includes(known.state)) return null;
        try {
          await authorize(ctx, { operation: "poll", ...facts(known), scopeKey: known.scopeKey });
        } catch {
          // Revoked authority forbids further provider access. Finalizing only
          // our existing metadata is safe housekeeping, not permission to run
          // the callback or launch work. Keep the uncertainty visible so a
          // later authorized host can reconcile it through job().
          await ctx.runMutation(component.state.finishJob, {
            jobId: known._id,
            claim: known.claim,
            state: "unknown",
          });
          return null;
        }
        const job = await ctx.runMutation(component.state.claimPoll, args);
        if (!job) return null;
        let outcome;
        let killed: boolean | undefined;
        try {
          if (job.deadline <= Date.now() || job.state === "starting" || !job.providerJobId) {
            // Even an unacknowledged launch has a pre-persisted location.
            // Kill is a bounded best effort; failure remains unknown and
            // never starts a second scheduler chain or retries paid work.
            killed = await kill(ctx, job.providerJobId!, job);
            outcome = {
              state: "unknown" as const,
              ...(job.deadline <= Date.now() ? { code: "SANDBOX_JOB_DEADLINE" as const } : {}),
            };
          } else {
            outcome = await within(
              ctx,
              () => provider.poll(ctx, job.providerJobId!, job),
              Math.max(1, job.deadline - Date.now()),
            );
          }
          if (
            !["running", "done", "failed", "unknown"].includes(outcome.state) ||
            (outcome.exitCode !== undefined && !Number.isSafeInteger(outcome.exitCode)) ||
            (outcome.logTail !== undefined && typeof outcome.logTail !== "string")
          )
            throw new Error("SANDBOX_INVALID_JOB_OUTCOME");
        } catch {
          // Status reads are safe to retry. A transient failure must not turn
          // off the watchdog while its paid process group is still running.
          outcome = { state: "running" as const };
        }
        if (Date.now() >= job.deadline && outcome.state === "running")
          outcome = { state: "unknown" as const, code: "SANDBOX_JOB_DEADLINE" as const };
        if (outcome.state === "unknown") {
          killed ??= await kill(ctx, job.providerJobId!, job);
          // Before the deadline, retry an uncertain kill with the same bounded
          // backoff. At the deadline, one bounded final attempt ends the chain
          // even if the provider never acknowledges cancellation.
          if (!killed && Date.now() < job.deadline) outcome = { state: "running" as const };
          else if (Date.now() >= job.deadline)
            outcome = { ...outcome, code: "SANDBOX_JOB_DEADLINE" as const };
        }
        if (outcome.state === "running")
          await ctx.runMutation(component.state.again, { jobId: job._id, claim: job.claim });
        else {
          const completion: SettleArgs = {
            jobId: job._id,
            claim: job.claim,
            state: outcome.state,
            ...(outcome.code === undefined ? {} : { code: outcome.code }),
            ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
            ...(outcome.logTail === undefined
              ? {}
              : { logTail: tail(outcome.logTail, limits.outputChars) }),
          };
          try {
            await ctx.runMutation(options.refs.settle(), completion);
          } catch (error) {
            if (Date.now() < job.deadline) {
              // The callback transaction rolled back. Release this action's
              // lease and retry status/settlement with bounded backoff rather
              // than waiting for the interruption watchdog's full budget.
              await ctx.runMutation(component.state.again, { jobId: job._id, claim: job.claim });
              throw error;
            }
            // A permanently failing host callback cannot keep a scheduler
            // chain alive forever. Its mutation has rolled back; retain an
            // honest unknown outcome, cancel the watchdog and let the host
            // reconcile through job(). Never replay the provider command.
            await ctx.runMutation(component.state.finishJob, {
              jobId: job._id,
              claim: job.claim,
              state: "unknown",
              ...(outcome.code === undefined ? {} : { code: outcome.code }),
            });
          }
        }
        return null;
      },
    });
    const settle = internalMutationGeneric({
      args: {
        jobId: v.string(),
        claim: v.string(),
        state: v.union(v.literal("done"), v.literal("failed"), v.literal("unknown")),
        exitCode: v.optional(v.number()),
        logTail: v.optional(v.string()),
        code: v.optional(v.literal("SANDBOX_JOB_DEADLINE")),
      },
      returns: v.null(),
      handler: async (ctx, args: SettleArgs): Promise<null> => {
        const job = await ctx.runQuery(component.state.getJob, { jobId: args.jobId });
        if (!job) return null;
        await authorize(ctx, { operation: "poll", ...facts(job), scopeKey: job.scopeKey });
        const event = await ctx.runMutation(component.state.finishJob, args);
        if (event) await options.onComplete?.(ctx, event as SandboxJobEvent);
        return null;
      },
    });
    const cleanup = internalActionGeneric({
      args: {},
      returns: v.null(),
      handler: async (ctx): Promise<null> => {
        await authorize(ctx, { operation: "cleanup" });
        const rows = await ctx.runQuery(component.state.expired, { limit: limits.cleanupBatch });
        // Each deletion is its own small transaction/action. At the hard
        // maximum this action reads 64 * 8 KiB=512 KiB in its selection query;
        // no transaction loops over remote effects or the entire component.
        // A batch can outlast the 540 s budget (64 deletes of up to 30 s), so
        // the loop stops when a delete would not fit and reschedules itself:
        // every pass settles at least its first row, so the chain is finite.
        let deferred = false;
        for (const row of rows)
          if ((await remove(ctx, row.scopeKey, true)) === "deferred") {
            deferred = true;
            break;
          }
        if ((deferred || rows.length === limits.cleanupBatch) && options.refs)
          await ctx.scheduler.runAfter(0, options.refs.cleanup(), {});
        return null;
      },
    });
    return { poll, settle, cleanup };
  }

  return {
    limits,
    tools,
    slot,
    scopeKey,
    prepare,
    readFile,
    list,
    internalFunctions,
    /** Read a bounded job snapshot, including unknown outcomes needing host reconciliation. */
    async job(ctx: SandboxContext, input: PollArgs) {
      bounded(input.jobId, LIMITS.identityChars, "JOB_ID");
      const job = await ctx.runQuery(component.state.getJob, input);
      if (!job) return null;
      await authorize(ctx, { operation: "poll", ...facts(job), scopeKey: job.scopeKey });
      return {
        jobId: job._id,
        scopeKey: job.scopeKey,
        ...facts(job),
        state: job.state,
        ...(job.providerJobId ? { providerJobId: job.providerJobId } : {}),
        ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
        ...(job.logTail === undefined ? {} : { logTail: job.logTail }),
        ...(job.code === undefined ? {} : { code: job.code }),
      };
    },
    /** Schedule a finite TTL sweep on demand; mounting alone creates no timer. */
    async cleanup(ctx: SandboxContext) {
      await authorize(ctx, { operation: "cleanup" });
      if (!options.refs) throw new Error("SANDBOX_REFS_REQUIRED");
      return ctx.scheduler.runAfter(0, options.refs.cleanup(), {});
    },
    /**
     * Clear a lost create (an `unknown` reservation with no provider id) so the
     * scope can create again. A reservation that already has a sandbox id is
     * never forgotten. First find the possibly-created sandbox at the provider
     * (Daytona: label `agevexScope` / `userKey` equals `scopeKey(facts)`) and
     * delete it; forgetting an orphan that is still running keeps billing it.
     */
    async forget(ctx: SandboxContext, input: SandboxFacts): Promise<boolean> {
      const key = await scopeKey(input);
      await authorize(ctx, { operation: "forget", ...facts(input), scopeKey: key });
      return ctx.runMutation(component.state.forget, { scopeKey: key });
    },
    /** Explicit host deletion. Automatic provider deletion is always disabled. */
    async delete(tc: SandboxCall) {
      const key = await scopeKey(tc);
      await authorize(tc.ctx, { operation: "delete", ...facts(tc), scopeKey: key });
      await remove(tc.ctx, key, false);
    },
    /** Stop preserves the sandbox identity and filesystem for the next use. */
    async stop(tc: SandboxCall) {
      const key = await scopeKey(tc);
      await authorize(tc.ctx, { operation: "stop", ...facts(tc), scopeKey: key });
      const row = await tc.ctx.runQuery(component.state.get, { scopeKey: key });
      if (!row?.sandboxId) throw new Error("SANDBOX_NOT_FOUND");
      try {
        await within(tc.ctx, () => provider.stop(tc.ctx, row.sandboxId!));
        await tc.ctx.runMutation(component.state.save, {
          scopeKey: key,
          claim: row.claim,
          state: "stopped",
        });
        await observe(tc.ctx, row.sandboxId, "stop", "observed", tc);
      } catch (error) {
        await tc.ctx.runMutation(component.state.save, {
          scopeKey: key,
          claim: row.claim,
          state: "unknown",
        });
        await observe(tc.ctx, row.sandboxId, "stop", "unknown", tc);
        throw error;
      }
    },
    /** Export through native Agent storeFile, with no parallel file registry. */
    async export(ctx: SandboxContext, input: SandboxExportArgs): Promise<SandboxExportResult> {
      bounded(input.threadId, LIMITS.identityChars, "THREAD");
      bounded(input.path, LIMITS.pathChars, "PATH");
      if (!options.agent) throw new Error("SANDBOX_AGENT_REQUIRED");
      const principal = await authorize(ctx, { operation: "export", threadId: input.threadId });
      if (options.scope === "run" && !options.resolveThread)
        throw new Error("SANDBOX_THREAD_RESOLVER_REQUIRED");
      const trusted = options.resolveThread
        ? await options.resolveThread(ctx, input.threadId)
        : { subject: principal.subject, threadId: input.threadId, runId: input.threadId };
      if (trusted.subject !== principal.subject || trusted.threadId !== input.threadId)
        throw new Error("SANDBOX_FORBIDDEN");
      const key = await scopeKey(trusted);
      const row = await ctx.runQuery(component.state.get, { scopeKey: key });
      if (!row?.sandboxId) throw new Error("SANDBOX_NOT_FOUND");
      const tc: SandboxCall = {
        ...trusted,
        ctx,
        signal: new AbortController().signal,
        toolCallId: "export",
      };
      await prepare(tc);
      // Every component transaction holds constant-size metadata. Only this
      // action buffers bytes, in <=512 KiB windows; overflow creates no storage.
      const maximum = nodeExport ? limits.exportBytesNode : limits.exportBytes;
      const hash = sha256.create();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const maxBytes = Math.min(LIMITS.exportChunkBytes, maximum - bytes + 1);
        let chunk: Uint8Array;
        try {
          chunk = await within(ctx, () =>
            provider.download(ctx, row.sandboxId!, input.path, {
              maxBytes,
              offset: bytes,
              totalSizeLimit: maximum,
            }),
          );
          if (bytes + chunk.byteLength > maximum) throw new Error("SANDBOX_EXPORT_TOO_LARGE");
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "SANDBOX_EXPORT_TOO_LARGE")
            throw error;
          chunks.length = 0;
          if (!nodeExport && options.nodeExport)
            return within(ctx, () => ctx.runAction(options.nodeExport!, input));
          throw new Error(
            nodeExport
              ? "SANDBOX_EXPORT_TOO_LARGE: exceeds exportBytesNode (64 MiB hard maximum)"
              : "SANDBOX_EXPORT_TOO_LARGE: register sandboxNodeExport() in a use node file via nodeExport",
          );
        }
        if (chunk.byteLength > maxBytes) throw new Error("SANDBOX_EXPORT_WINDOW_TOO_LARGE");
        bytes += chunk.byteLength;
        hash.update(chunk);
        // Keep the provider-owned window; copying here needlessly duplicates it.
        chunks.push(chunk);
        if (chunk.byteLength < maxBytes) break;
      }
      remaining(ctx);
      const digest = bytesToHex(hash.digest());
      // Agent storeFile (0.7.7 src/vercel/client/files.ts:58-158) dedupes and
      // stores/registers the Blob once. Let it compute its native hex hash:
      // its supplied-sha256 branch compares hex to Convex's base64 metadata.
      // Compare with our incremental digest instead. Count all four possible
      // whole-file allocations honestly: chunks + Blob + Agent's blob.slice()
      // + its hashing ArrayBuffer (files.ts:62). Default: 4 * 8 MiB =32 MiB
      // plus <=512 KiB transport window, leaving ~31 MiB of the 64 MiB runtime.
      // Node: 4 * 64 MiB =256 MiB plus <=512 KiB window, leaving ~255 MiB of
      // 512 MiB. The incremental hasher is constant space; no extra file copy.
      const blob = new Blob(chunks as BlobPart[], { type: "application/octet-stream" });
      chunks.length = 0;
      const stored = await storeFile(ctx, options.agent, blob, {
        filename: input.path.split("/").pop(),
      });
      if (stored.file.hash !== digest) throw new Error("SANDBOX_EXPORT_HASH_MISMATCH");
      await observe(ctx, row.sandboxId, "export", "observed", trusted);
      return {
        fileId: stored.file.fileId,
        storageId: stored.file.storageId,
        bytes,
        sha256: stored.file.hash,
      };
    },
  };
}
