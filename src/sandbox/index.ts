import { storeFile } from "@convex-dev/agent";
import { tool, type ToolExecutionOptions } from "ai";
import {
  createFunctionHandle,
  internalActionGeneric,
  internalMutationGeneric,
  type GenericMutationCtx,
  type GenericDataModel,
} from "convex/server";
import { v, type GenericId } from "convex/values";
import { z } from "zod";
import { defineOnceTool, fingerprint, type ToolContext } from "../client/once.js";
import { LIMITS, bounded, integer, resolveLimits, tail } from "./limits.js";
import type {
  SandboxContext,
  SandboxFacts,
  SandboxOptions,
  SandboxAuthorization,
  SandboxUsageEvent,
  SandboxJobEvent,
  PollArgs,
  SettleArgs,
} from "./types.js";

export { daytona } from "./daytona.js";
export { LIMITS, HARD_LIMITS } from "./limits.js";
export type { SandboxLimits } from "./limits.js";
export type * from "./types.js";
export type { ComponentApi } from "./component/_generated/component.js";

/**
 * Bind sandboxes to trusted request facts. Mount this optional component on its
 * own; core and the Agent component never depend on its schema. Public host
 * endpoints must call these helpers rather than exposing component references.
 */
export function defineSandbox(options: SandboxOptions) {
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
  async function within<T>(ctx: SandboxContext, invoke: () => Promise<T>): Promise<T> {
    const ms = remaining(ctx);
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
  async function prepare(tc: ToolContext) {
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

  async function exec(tc: ToolContext, input: { command: string }) {
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
  async function readFile(tc: ToolContext, input: { path: string }) {
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

  async function writeFile(tc: ToolContext, input: { path: string; content: string }) {
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
  async function list(tc: ToolContext, input: { path: string }) {
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

  async function background(tc: ToolContext, input: { command: string }) {
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
    try {
      tc.signal.throwIfAborted();
      const launched = await within(tc.ctx, () =>
        provider.startBackground(tc.ctx, sandboxId, input.command),
      );
      if (
        !(await tc.ctx.runMutation(component.state.attachJob, {
          ...admitted,
          providerJobId: launched.jobId,
        }))
      )
        throw new Error("SANDBOX_STALE_JOB");
      await observe(tc.ctx, sandboxId, "background", "observed", tc);
      return { status: "running" as const, jobId: admitted.jobId };
    } catch {
      await tc.ctx.runMutation(options.refs.settle(), { ...admitted, state: "unknown" });
      await observe(tc.ctx, sandboxId, "background", "unknown", tc);
      return { status: "unknown" as const, jobId: admitted.jobId };
    }
  }

  /**
   * Plain SDK tools. Effects are bound by core's defineOnceTool ledger. Pure
   * reads accept trusted AI SDK `context` (or an explicit host ToolContext),
   * avoiding storing up to 640 KiB of file text in a 64 KiB receipt.
   */
  function tools(context?: ToolContext) {
    const key = (_input: unknown, tc: ToolContext) => {
      // Validate attribution before core constructs a receipt scope, rather
      // than waiting until the effect body after admission has already written.
      facts(tc);
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
      return { ...tc, toolCallId: opts.toolCallId };
    };
    return {
      sandbox_exec: defineOnceTool({
        name: "sandbox_exec",
        key,
        input: z.object({ command }),
        run: (input, tc) => exec(tc, input),
      }),
      sandbox_read_file: tool({
        description: "Read the bounded tail of a sandbox file.",
        inputSchema: z.object({ path }),
        execute: (input, opts) => readFile(readContext(opts), input),
      }),
      sandbox_write_file: defineOnceTool({
        name: "sandbox_write_file",
        key,
        input: z.object({ path, content: z.string().max(limits.writeChars) }),
        run: (input, tc) => writeFile(tc, input),
      }),
      sandbox_list: tool({
        description: "List a bounded directory in the request's sandbox.",
        inputSchema: z.object({ path }),
        execute: (input, opts) => list(readContext(opts), input),
      }),
      sandbox_run_background: defineOnceTool({
        name: "sandbox_run_background",
        key,
        input: z.object({ command }),
        run: (input, tc) => background(tc, input),
      }),
    };
  }

  async function remove(ctx: SandboxContext, key: string, expiredOnly: boolean) {
    await authorize(ctx, { operation: "delete", scopeKey: key });
    const binding = await ctx.runMutation(component.state.claimDelete, {
      scopeKey: key,
      expiredOnly,
    });
    if (!binding) return;
    try {
      await within(ctx, () => provider.delete(ctx, binding.sandboxId));
      await ctx.runMutation(component.state.save, { scopeKey: key, ...binding, state: "deleted" });
      await observe(ctx, binding.sandboxId, "delete", "observed");
    } catch {
      await ctx.runMutation(component.state.save, { scopeKey: key, ...binding, state: "unknown" });
      await observe(ctx, binding.sandboxId, "delete", "unknown");
    }
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
        try {
          outcome =
            !job.providerJobId || job.deadline <= Date.now()
              ? { state: "unknown" as const }
              : await within(ctx, () => provider.poll(ctx, job.providerJobId!));
          if (
            !["running", "done", "failed", "unknown"].includes(outcome.state) ||
            (outcome.exitCode !== undefined && !Number.isSafeInteger(outcome.exitCode)) ||
            (outcome.logTail !== undefined && typeof outcome.logTail !== "string")
          )
            throw new Error("SANDBOX_INVALID_JOB_OUTCOME");
        } catch {
          outcome = { state: "unknown" as const };
        }
        if (outcome.state === "running")
          await ctx.runMutation(component.state.again, { jobId: job._id, claim: job.claim });
        else {
          const completion: SettleArgs = {
            jobId: job._id,
            claim: job.claim,
            state: outcome.state,
            ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
            ...(outcome.logTail === undefined
              ? {}
              : { logTail: tail(outcome.logTail, limits.outputChars) }),
          };
          try {
            await ctx.runMutation(options.refs.settle(), completion);
          } catch (error) {
            if (Date.now() < job.deadline) throw error;
            // A permanently failing host callback cannot keep a scheduler
            // chain alive forever. Its mutation has rolled back; retain an
            // honest unknown outcome, cancel the watchdog and let the host
            // reconcile through job(). Never replay the provider command.
            await ctx.runMutation(component.state.finishJob, {
              jobId: job._id,
              claim: job.claim,
              state: "unknown",
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
        for (const row of rows) await remove(ctx, row.scopeKey, true);
        if (rows.length === limits.cleanupBatch && options.refs)
          await ctx.scheduler.runAfter(0, options.refs.cleanup(), {});
        return null;
      },
    });
    return { poll, settle, cleanup };
  }

  return {
    limits,
    tools,
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
      };
    },
    /** Schedule a finite TTL sweep on demand; mounting alone creates no timer. */
    async cleanup(ctx: SandboxContext) {
      await authorize(ctx, { operation: "cleanup" });
      if (!options.refs) throw new Error("SANDBOX_REFS_REQUIRED");
      return ctx.scheduler.runAfter(0, options.refs.cleanup(), {});
    },
    /** Explicit host deletion. Automatic provider deletion is always disabled. */
    async delete(tc: ToolContext) {
      const key = await scopeKey(tc);
      await authorize(tc.ctx, { operation: "delete", ...facts(tc), scopeKey: key });
      await remove(tc.ctx, key, false);
    },
    /** Stop preserves the sandbox identity and filesystem for the next use. */
    async stop(tc: ToolContext) {
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
    async export(
      ctx: SandboxContext,
      input: { threadId: string; path: string },
    ): Promise<{
      fileId: string;
      storageId: GenericId<"_storage">;
      bytes: number;
      sha256: string;
    }> {
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
      const tc: ToolContext = {
        ...trusted,
        ctx,
        signal: new AbortController().signal,
        toolCallId: "export",
      };
      await prepare(tc);
      const bytes = await within(ctx, () =>
        provider.download(ctx, row.sandboxId!, input.path, { maxBytes: limits.exportBytes }),
      );
      if (bytes.byteLength > limits.exportBytes) throw new Error("SANDBOX_EXPORT_TOO_LARGE");
      // Native storeFile computes/verifies SHA-256 and performs hash dedupe.
      // agent 0.7.7 src/vercel/client/files.ts:47-158 owns storage lifecycle.
      const stored = await storeFile(
        ctx,
        options.agent,
        new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
        { filename: input.path.split("/").pop() },
      );
      await observe(ctx, row.sandboxId, "export", "observed", trusted);
      return {
        fileId: stored.file.fileId,
        storageId: stored.file.storageId,
        bytes: bytes.byteLength,
        sha256: stored.file.hash,
      };
    },
  };
}
