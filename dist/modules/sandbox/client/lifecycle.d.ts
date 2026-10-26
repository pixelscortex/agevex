import { type SandboxCall, type SandboxContext, type SandboxFacts, type PollArgs } from "./types.js";
import { type RuntimeContext } from "./runtime-context.js";
/** Reserve once, save the provider id, then resume within the shared action deadline. */
export declare function prepare(runtime: RuntimeContext, tc: SandboxCall, opts?: {
    existingOnly?: boolean;
}): Promise<{
    sandboxId: string;
    scopeKey: string;
    claim: string;
}>;
/**
 * Returns "deferred" when the action budget is too short to finish a delete.
 * Checked BEFORE claimDelete: a claimed delete that then times out is
 * recorded as unknown, which would strand a healthy idle sandbox. A deferred
 * row is untouched and the next sweep (with a fresh budget) takes it.
 */
export declare function remove(runtime: RuntimeContext, ctx: SandboxContext, key: string, expiredOnly: boolean): Promise<"deferred" | "done">;
/** Read a bounded job snapshot, including unknown outcomes needing host reconciliation. */
export declare function jobSnapshot(runtime: RuntimeContext, ctx: SandboxContext, input: PollArgs): Promise<{
    code?: "SANDBOX_JOB_DEADLINE" | undefined;
    logTail?: string | undefined;
    exitCode?: number | undefined;
    providerJobId?: string | undefined;
    state: "failed" | "running" | "done" | "unknown" | "starting";
    subject: string;
    threadId: string;
    runId: string;
    jobId: string;
    scopeKey: string;
} | null>;
/** Schedule a finite TTL sweep on demand; mounting alone creates no timer. */
export declare function scheduleCleanup(runtime: RuntimeContext, ctx: SandboxContext): Promise<import("convex/values").GenericId<"_scheduled_functions">>;
/**
 * Clear a lost create (an `unknown` reservation with no provider id) so the
 * scope can create again. A reservation that already has a sandbox id is
 * never forgotten. First find the possibly-created sandbox at the provider
 * (Daytona: label `agevexScope` / `userKey` equals `scopeKey(facts)`) and
 * delete it; forgetting an orphan that is still running keeps billing it.
 */
export declare function forgetSandbox(runtime: RuntimeContext, ctx: SandboxContext, input: SandboxFacts): Promise<boolean>;
/** Explicit host deletion. Automatic provider deletion is always disabled. */
export declare function deleteSandbox(runtime: RuntimeContext, tc: SandboxCall): Promise<void>;
/** Stop preserves the sandbox identity and filesystem for the next use. */
export declare function stopSandbox(runtime: RuntimeContext, tc: SandboxCall): Promise<void>;
