/**
 * Host sandbox lifecycle and reconciliation operations.
 * The public API calls these helpers with validated runtime context.
 * Identity is saved before readiness; claim tokens fence stale actions and deletion.
 */
import { LIMITS, bounded } from "../shared/limits.js";
import {
  type SandboxCall,
  type SandboxContext,
  type SandboxFacts,
  type PollArgs,
} from "./types.js";
import {
  remaining,
  within,
  facts,
  scopeKey,
  authorize,
  observe,
  hasBudget,
  type RuntimeContext,
} from "./runtime-context.js";

/** Reserve once, save the provider id, then resume within the shared action deadline. */
export async function prepare(
  runtime: RuntimeContext,
  tc: SandboxCall,
  opts: { existingOnly?: boolean } = {},
) {
  const { limits, component, provider } = runtime;

  tc.signal.throwIfAborted();
  remaining(runtime, tc.ctx);
  const trusted = facts(tc);
  const key = await scopeKey(runtime, tc);

  await authorize(runtime, tc.ctx, { operation: "use", scopeKey: key, ...trusted });

  const reservation = await tc.ctx.runMutation(component.state.reserve, {
    scopeKey: key,
    provider: provider.id,
    ttl: limits.ttl,
    ...(opts.existingOnly ? { existingOnly: true } : {}),
  });

  if (reservation.status === "running" || reservation.status === "unknown")
    throw new Error(`SANDBOX_${reservation.status.toUpperCase()}`);

  if (!reservation.claim) throw new Error("SANDBOX_INVALID_RESERVATION");

  const claim = reservation.claim;
  let sandboxId = reservation.status === "existing" ? reservation.sandboxId : undefined;

  try {
    if (!sandboxId) {
      const created = await within(runtime, tc.ctx, () =>
        provider.create(tc.ctx, { scopeKey: key }),
      );

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

      await observe(runtime, tc.ctx, sandboxId, "create", "observed", tc);
    }

    tc.signal.throwIfAborted();
    await within(runtime, tc.ctx, () => provider.resume(tc.ctx, sandboxId!));
    tc.signal.throwIfAborted();
    await authorize(runtime, tc.ctx, { operation: "use", scopeKey: key, ...trusted });

    if (
      !(await tc.ctx.runMutation(component.state.save, {
        scopeKey: key,
        claim,
        sandboxId,
        state: "ready",
      }))
    )
      throw new Error("SANDBOX_STALE");

    await observe(runtime, tc.ctx, sandboxId, "resume", "observed", tc);

    return { sandboxId, scopeKey: key, claim };
  } catch (error) {
    await tc.ctx.runMutation(component.state.save, {
      scopeKey: key,
      claim,
      ...(sandboxId ? { sandboxId } : {}),
      state: "unknown",
    });

    await observe(runtime, tc.ctx, sandboxId, sandboxId ? "resume" : "create", "unknown", tc);
    throw error;
  }
}

/**
 * Returns "deferred" when the action budget is too short to finish a delete.
 * Checked BEFORE claimDelete: a claimed delete that then times out is
 * recorded as unknown, which would strand a healthy idle sandbox. A deferred
 * row is untouched and the next sweep (with a fresh budget) takes it.
 */
export async function remove(
  runtime: RuntimeContext,
  ctx: SandboxContext,
  key: string,
  expiredOnly: boolean,
) {
  const { component, provider } = runtime;

  await authorize(runtime, ctx, { operation: "delete", scopeKey: key });

  if (!hasBudget(runtime, ctx, LIMITS.deleteMinBudgetMs)) {
    if (!expiredOnly) throw new Error("SANDBOX_ACTION_DEADLINE");

    return "deferred" as const;
  }

  const binding = await ctx.runMutation(component.state.claimDelete, {
    scopeKey: key,
    expiredOnly,
  });

  if (!binding) return "done" as const;

  try {
    await within(runtime, ctx, () => provider.delete(ctx, binding.sandboxId));
    await ctx.runMutation(component.state.save, { scopeKey: key, ...binding, state: "deleted" });
    await observe(runtime, ctx, binding.sandboxId, "delete", "observed");
  } catch {
    await ctx.runMutation(component.state.save, { scopeKey: key, ...binding, state: "unknown" });
    await observe(runtime, ctx, binding.sandboxId, "delete", "unknown");
  }

  return "done" as const;
}

/** Read a bounded job snapshot, including unknown outcomes needing host reconciliation. */
export async function jobSnapshot(runtime: RuntimeContext, ctx: SandboxContext, input: PollArgs) {
  const { component } = runtime;

  bounded(input.jobId, LIMITS.identityChars, "JOB_ID");
  const job = await ctx.runQuery(component.state.getJob, input);

  if (!job) return null;

  await authorize(runtime, ctx, { operation: "poll", ...facts(job), scopeKey: job.scopeKey });

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
}

/** Schedule a finite TTL sweep on demand; mounting alone creates no timer. */
export async function scheduleCleanup(runtime: RuntimeContext, ctx: SandboxContext) {
  const { options } = runtime;

  await authorize(runtime, ctx, { operation: "cleanup" });

  if (!options.refs) throw new Error("SANDBOX_REFS_REQUIRED");

  return ctx.scheduler.runAfter(0, options.refs.cleanup(), {});
}

/**
 * Clear a lost create (an `unknown` reservation with no provider id) so the
 * scope can create again. A reservation that already has a sandbox id is
 * never forgotten. First find the possibly-created sandbox at the provider
 * (Daytona: label `agevexScope` / `userKey` equals `scopeKey(facts)`) and
 * delete it; forgetting an orphan that is still running keeps billing it.
 */
export async function forgetSandbox(
  runtime: RuntimeContext,
  ctx: SandboxContext,
  input: SandboxFacts,
): Promise<boolean> {
  const { component } = runtime;
  const key = await scopeKey(runtime, input);

  await authorize(runtime, ctx, { operation: "forget", ...facts(input), scopeKey: key });

  return ctx.runMutation(component.state.forget, { scopeKey: key });
}

/** Explicit host deletion. Automatic provider deletion is always disabled. */
export async function deleteSandbox(runtime: RuntimeContext, tc: SandboxCall) {
  const key = await scopeKey(runtime, tc);

  await authorize(runtime, tc.ctx, { operation: "delete", ...facts(tc), scopeKey: key });
  await remove(runtime, tc.ctx, key, false);
}

/** Stop preserves the sandbox identity and filesystem for the next use. */
export async function stopSandbox(runtime: RuntimeContext, tc: SandboxCall) {
  const { component, provider } = runtime;
  const key = await scopeKey(runtime, tc);

  await authorize(runtime, tc.ctx, { operation: "stop", ...facts(tc), scopeKey: key });
  const row = await tc.ctx.runQuery(component.state.get, { scopeKey: key });

  if (!row?.sandboxId) throw new Error("SANDBOX_NOT_FOUND");

  try {
    await within(runtime, tc.ctx, () => provider.stop(tc.ctx, row.sandboxId!));

    await tc.ctx.runMutation(component.state.save, {
      scopeKey: key,
      claim: row.claim,
      state: "stopped",
    });

    await observe(runtime, tc.ctx, row.sandboxId, "stop", "observed", tc);
  } catch (error) {
    await tc.ctx.runMutation(component.state.save, {
      scopeKey: key,
      claim: row.claim,
      state: "unknown",
    });

    await observe(runtime, tc.ctx, row.sandboxId, "stop", "unknown", tc);
    throw error;
  }
}
