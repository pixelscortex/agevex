/**
 * Validated host runtime context, identity checks and shared action deadlines.
 * Lifecycle, tools and watchdog builders share this context and its deadline map.
 * Authorization remains host-owned; usage recording cannot turn success into failure.
 */
import { type GenericMutationCtx, type GenericDataModel } from "convex/server";
import { fingerprint } from "../../../client/once.js";
import { LIMITS, bounded, resolveLimits, type SandboxLimits } from "../shared/limits.js";
import {
  type SandboxContext,
  type SandboxFacts,
  type SandboxOptions,
  type SandboxAuthorization,
  type SandboxUsageEvent,
} from "./types.js";

export type RuntimeContext = {
  options: SandboxOptions;
  limits: SandboxLimits;
  component: SandboxOptions["component"];
  provider: SandboxOptions["provider"];
  nodeExport: boolean;
  deadlines: WeakMap<SandboxContext, number>;
};

/** Validate host configuration once; all builders receive this shared action budget. */
export function createRuntimeContext(options: SandboxOptions, nodeExport: boolean): RuntimeContext {
  const limits = resolveLimits(options.limits);
  const { component, provider } = options;

  bounded(provider.id, LIMITS.providerChars, "PROVIDER");

  if (!["thread", "run", "subject"].includes(options.scope))
    throw new Error("SANDBOX_INVALID_SCOPE");

  if (typeof options.authorize !== "function") throw new Error("SANDBOX_AUTHORIZATION_REQUIRED");

  return { options, limits, component, provider, nodeExport, deadlines: new WeakMap() };
}

/** Start or read this action context’s shared deadline before any provider work. */
export function remaining(runtime: RuntimeContext, ctx: SandboxContext) {
  const { deadlines } = runtime;
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
export async function within<T>(
  runtime: RuntimeContext,
  ctx: SandboxContext,
  invoke: () => Promise<T>,
  budgetMs?: number,
): Promise<T> {
  const ms = Math.min(remaining(runtime, ctx), budgetMs ?? LIMITS.actionBudgetMs);
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
export async function kill(
  runtime: RuntimeContext,
  ctx: SandboxContext,
  jobId: string,
  location: Parameters<RuntimeContext["provider"]["cancelBackground"]>[2],
) {
  const { provider } = runtime;
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

/** Validate trusted attribution before keying a scope, admitting a receipt or storing metadata. */
export function facts(tc: SandboxFacts) {
  for (const key of ["subject", "threadId", "runId"] as const)
    bounded(tc[key], LIMITS.identityChars, key);

  return { subject: tc.subject, threadId: tc.threadId, runId: tc.runId };
}

/** Stable subject-isolated key; request bodies and model arguments are never part of binding. */
export async function scopeKey(runtime: RuntimeContext, tc: SandboxFacts) {
  const { options } = runtime;
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

/** Recheck host policy and reject any mismatch with the already-bound subject. */
export async function authorize(
  runtime: RuntimeContext,
  ctx: SandboxContext | GenericMutationCtx<GenericDataModel>,
  request: SandboxAuthorization,
) {
  const { options } = runtime;
  const principal = await options.authorize(ctx, request);

  bounded(principal.subject, LIMITS.identityChars, "SUBJECT");

  if (request.subject !== undefined && principal.subject !== request.subject)
    throw new Error("SANDBOX_FORBIDDEN");

  return principal;
}

/** Record best-effort usage after an effect, keeping accounting failures out of effect outcomes. */
export async function observe(
  runtime: RuntimeContext,
  ctx: SandboxContext,
  sandboxId: string | undefined,
  operation: SandboxUsageEvent["operation"],
  outcome: SandboxUsageEvent["outcome"],
  tc?: SandboxFacts,
) {
  const { options, provider } = runtime;

  // Observability cannot turn an acknowledged effect into a failure. There
  // is deliberately no zero-cost claim: Daytona observations are estimates.
  try {
    await options.usage?.record(ctx, {
      ...(tc ? facts(tc) : {}),
      provider: provider.id,
      ...(sandboxId ? { sandboxId } : {}),
      ...(tc ? { scopeKey: await scopeKey(runtime, tc) } : {}),
      operation,
      outcome,
      source: "estimate",
      at: Date.now(),
    });
  } catch {
    /* Host accounting is independent of provider success. */
  }
}

/** True while at least `minMs` of this action's shared budget remains. */
export function hasBudget(runtime: RuntimeContext, ctx: SandboxContext, minMs: number) {
  try {
    return remaining(runtime, ctx) >= minMs;
  } catch {
    return false;
  }
}
