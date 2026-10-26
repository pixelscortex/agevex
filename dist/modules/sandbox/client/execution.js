/**
 * Host command execution and background-launch admission.
 * Once-tool bodies call these helpers with trusted facts and validated runtime context.
 * Provider identities and watchdogs commit before launch; uncertain paid work never retries.
 */
import { createFunctionHandle } from "convex/server";
import { LIMITS, bounded, tail } from "../shared/limits.js";
import {} from "./types.js";
import { remaining, within, kill, facts, observe } from "./runtime-context.js";
import { prepare } from "./lifecycle.js";
/** Run an admitted command once with a kill margin and a shared stdout/stderr receipt bound. */
export async function exec(runtime, tc, input) {
    const { limits, provider } = runtime;
    bounded(input.command, LIMITS.commandChars, "COMMAND");
    const binding = await prepare(runtime, tc);
    // Leave execKillMarginS of the shared budget for the provider to kill the
    // command's process group after its timeout; without it a command that
    // times out exactly at the action deadline is cut off un-killed.
    const timeoutS = Math.min(limits.commandTimeoutS, Math.floor((remaining(runtime, tc.ctx) - LIMITS.execKillMarginS * LIMITS.millisecondsPerSecond) /
        LIMITS.millisecondsPerSecond));
    if (timeoutS < 1)
        throw new Error("SANDBOX_ACTION_DEADLINE");
    tc.signal.throwIfAborted();
    try {
        const result = await within(runtime, tc.ctx, () => provider.exec(tc.ctx, binding.sandboxId, input.command, { timeoutS, signal: tc.signal }));
        if (!Number.isSafeInteger(result.exitCode))
            throw new Error("SANDBOX_INVALID_EXIT_CODE");
        tc.signal.throwIfAborted();
        // stdout and stderr share the allowance so even all-four-byte Unicode
        // fits core's receipt. Prefer diagnostic stderr when both overflow.
        const stderr = tail(result.stderr, limits.outputChars);
        const stdout = limits.outputChars > stderr.length
            ? tail(result.stdout, limits.outputChars - stderr.length)
            : "";
        await observe(runtime, tc.ctx, binding.sandboxId, "exec", "observed", tc);
        return {
            status: "done",
            exitCode: result.exitCode,
            // True only when the sandbox killed the command for exceeding the
            // timeout, so a command that itself exits 124 is not mistaken for it.
            timedOut: result.timedOut === true,
            stdout,
            stderr,
            truncated: stdout.length < result.stdout.length || stderr.length < result.stderr.length,
        };
    }
    catch {
        await observe(runtime, tc.ctx, binding.sandboxId, "exec", "unknown", tc);
        return { status: "unknown" };
    }
}
/** Persist job identity and watchdog before launch; uncertainty never launches the command again. */
export async function background(runtime, tc, input) {
    const { options, limits, component, provider } = runtime;
    bounded(input.command, LIMITS.commandChars, "COMMAND");
    if (!options.refs)
        throw new Error("SANDBOX_REFS_REQUIRED");
    const { sandboxId, scopeKey: key } = await prepare(runtime, tc);
    const admitted = await tc.ctx.runMutation(component.state.reserveJob, {
        scopeKey: key,
        ...facts(tc),
        pollHandle: await createFunctionHandle(options.refs.wake()),
        pollMinMs: limits.pollMinMs,
        pollMaxMs: limits.pollMaxMs,
        jobTimeoutMs: limits.jobTimeoutMs,
        maximum: limits.jobsPerSandbox,
    });
    const admission = { jobId: admitted.jobId, claim: admitted.claim };
    try {
        tc.signal.throwIfAborted();
        const launched = await within(runtime, tc.ctx, () => provider.startBackground(tc.ctx, sandboxId, input.command, {
            jobId: admitted.providerJobId,
            sandboxId,
            directory: admitted.directory,
        }));
        if (!(await tc.ctx.runMutation(component.state.attachJob, {
            ...admission,
            providerJobId: launched.jobId,
        })))
            throw new Error("SANDBOX_STALE_JOB");
        await observe(runtime, tc.ctx, sandboxId, "background", "observed", tc);
        return { status: "running", jobId: admitted.jobId };
    }
    catch {
        const cancelled = await kill(runtime, tc.ctx, admitted.providerJobId, admitted);
        try {
            // An uncertain cancellation keeps the persisted deadline watchdog.
            // It can kill again, but can never replay the original launch.
            if (cancelled)
                await tc.ctx.runMutation(options.refs.settle(), { ...admission, state: "unknown" });
        }
        catch {
            // The reservation's persisted watchdog retries the atomic callback
            // within its deadline. Its failure cannot replace an uncertain paid
            // launch with TOOL_FAILED or discard the only reconciliation id.
        }
        await observe(runtime, tc.ctx, sandboxId, "background", "unknown", tc);
        return { status: "unknown", jobId: admitted.jobId };
    }
}
