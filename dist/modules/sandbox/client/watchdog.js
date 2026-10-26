/**
 * Host wake, poll, settlement and on-demand cleanup registrations.
 * The component job claim atomically persists a watchdog before scheduling a poll.
 * Only safe status reads retry; deadlines and late-attempt bounds end every chain.
 */
import {} from "./types.js";
import { internalActionGeneric, internalMutationGeneric, } from "convex/server";
import { ConvexError, v } from "convex/values";
import { tail } from "../shared/limits.js";
import { within, kill, facts, authorize } from "./runtime-context.js";
import { remove } from "./lifecycle.js";
/** Compose the finite watchdog and cleanup host registrations. */
export function internalFunctions(runtime) {
    return {
        wake: buildWake(runtime),
        poll: buildPoll(runtime),
        settle: buildSettle(runtime),
        cleanup: buildCleanup(runtime),
    };
}
/**
 * The scheduler only calls this mutation: claiming the job persists a lease
 * backstop atomically with scheduling the poll action. If that action dies,
 * the backstop retries; consuming a wake never leaves the job unscheduled.
 */
export function buildWake(runtime) {
    const { options, component } = runtime;
    return internalMutationGeneric({
        args: { jobId: v.string() },
        returns: v.null(),
        handler: async (ctx, args) => {
            if (!options.refs)
                throw new Error("SANDBOX_REFS_REQUIRED");
            const known = await ctx.runQuery(component.state.getJob, args);
            if (!known || !["starting", "running"].includes(known.state))
                return null;
            const job = await ctx.runMutation(component.state.claimPoll, args);
            if (!job)
                return null;
            try {
                await authorize(runtime, ctx, {
                    operation: "poll",
                    ...facts(known),
                    scopeKey: known.scopeKey,
                });
            }
            catch (error) {
                // A thrown error would roll the claim back and lose the backstop, so
                // it is always caught. Only a definite FORBIDDEN means authority was
                // revoked: that forbids provider access and the callback, but
                // finalizing our own metadata is safe housekeeping. Keep the
                // uncertainty visible so a later authorized host can reconcile it
                // through job(). Anything else (an outage, a timeout) is transient:
                // release the claim into the normal backoff (not the long lease), so
                // the next wake comes within the poll delay. Retries are bounded by
                // the deadline and the late-attempt limit, after which the job ends
                // unknown without a kill.
                if (!isForbidden(error)) {
                    await ctx.runMutation(component.state.again, { jobId: known._id, claim: job.claim });
                    return null;
                }
                await ctx.runMutation(component.state.finishJob, {
                    jobId: known._id,
                    claim: job.claim,
                    state: "unknown",
                });
                return null;
            }
            await ctx.scheduler.runAfter(0, options.refs.poll(), {
                jobId: known._id,
                claim: job.claim,
            });
            return null;
        },
    });
}
/** Poll the claimed job, retrying safe reads and callback settlement only within its deadline. */
export function buildPoll(runtime) {
    const { options, limits, component } = runtime;
    return internalActionGeneric({
        args: { jobId: v.string(), claim: v.string() },
        returns: v.null(),
        handler: async (ctx, args) => {
            if (!options.refs)
                throw new Error("SANDBOX_REFS_REQUIRED");
            const job = await ctx.runQuery(component.state.getJob, { jobId: args.jobId });
            // Superseded (a later claim took over) or already terminal.
            if (!job || !["starting", "running"].includes(job.state) || job.claim !== args.claim)
                return null;
            const outcome = await pollOutcome(runtime, ctx, job);
            if (outcome.state === "running")
                await ctx.runMutation(component.state.again, { jobId: job._id, claim: job.claim });
            else {
                const completion = {
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
                }
                catch (error) {
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
}
/** Finish metadata and invoke the completion callback in one rollback-safe host transaction. */
export function buildSettle(runtime) {
    const { options, component } = runtime;
    return internalMutationGeneric({
        args: {
            jobId: v.string(),
            claim: v.string(),
            state: v.union(v.literal("done"), v.literal("failed"), v.literal("unknown")),
            exitCode: v.optional(v.number()),
            logTail: v.optional(v.string()),
            code: v.optional(v.literal("SANDBOX_JOB_DEADLINE")),
        },
        returns: v.null(),
        handler: async (ctx, args) => {
            const job = await ctx.runQuery(component.state.getJob, { jobId: args.jobId });
            if (!job)
                return null;
            await authorize(runtime, ctx, { operation: "poll", ...facts(job), scopeKey: job.scopeKey });
            const event = await ctx.runMutation(component.state.finishJob, args);
            if (event)
                await options.onComplete?.(ctx, event);
            return null;
        },
    });
}
/** Drain one bounded TTL batch on demand, deferring deletes that cannot fit the action budget. */
export function buildCleanup(runtime) {
    const { options, limits, component } = runtime;
    return internalActionGeneric({
        args: {},
        returns: v.null(),
        handler: async (ctx) => {
            await authorize(runtime, ctx, { operation: "cleanup" });
            const rows = await ctx.runQuery(component.state.expired, { limit: limits.cleanupBatch });
            // Each deletion is its own small transaction/action. At the hard
            // maximum this action reads 64 * 8 KiB=512 KiB in its selection query;
            // no transaction loops over remote effects or the entire component.
            // A batch can outlast the 540 s budget (64 deletes of up to 30 s), so
            // the loop stops when a delete would not fit and reschedules itself:
            // every pass settles at least its first row, so the chain is finite.
            let deferred = false;
            for (const row of rows)
                if ((await remove(runtime, ctx, row.scopeKey, true)) === "deferred") {
                    deferred = true;
                    break;
                }
            if ((deferred || rows.length === limits.cleanupBatch) && options.refs)
                await ctx.scheduler.runAfter(0, options.refs.cleanup(), {});
            return null;
        },
    });
}
/**
 * A definite host denial, as opposed to an outage or timeout while checking.
 * Accepted shapes, exactly: `new ConvexError("FORBIDDEN")`,
 * `new ConvexError({ code: "FORBIDDEN" })`, or an `Error` whose message is
 * `FORBIDDEN` or `SANDBOX_FORBIDDEN` (optionally followed by a non-word
 * character and detail). Everything else is treated as transient.
 */
function isForbidden(error) {
    if (error instanceof ConvexError) {
        const data = error.data;
        return data === "FORBIDDEN" || data?.code === "FORBIDDEN";
    }
    return error instanceof Error && /^(SANDBOX_)?FORBIDDEN\b/.test(error.message);
}
/** Read status and bound kill retries; unknown effects never replay a command. */
async function pollOutcome(runtime, ctx, job) {
    const { provider } = runtime;
    let outcome;
    let killed;
    try {
        if (job.deadline <= Date.now() || job.state === "starting" || !job.providerJobId) {
            // Even an unacknowledged launch has a pre-persisted location.
            // Kill is a bounded best effort; failure remains unknown and
            // never starts a second scheduler chain or retries paid work.
            killed = await kill(runtime, ctx, job.providerJobId, job);
            outcome = {
                state: "unknown",
                ...(job.deadline <= Date.now() ? { code: "SANDBOX_JOB_DEADLINE" } : {}),
            };
        }
        else {
            outcome = await within(runtime, ctx, () => provider.poll(ctx, job.providerJobId, job), Math.max(1, job.deadline - Date.now()));
        }
        if (!["running", "done", "failed", "unknown"].includes(outcome.state) ||
            (outcome.exitCode !== undefined && !Number.isSafeInteger(outcome.exitCode)) ||
            (outcome.logTail !== undefined && typeof outcome.logTail !== "string"))
            throw new Error("SANDBOX_INVALID_JOB_OUTCOME");
    }
    catch {
        // Status reads are safe to retry. A transient failure must not turn
        // off the watchdog while its paid process group is still running.
        outcome = { state: "running" };
    }
    if (Date.now() >= job.deadline && outcome.state === "running")
        outcome = { state: "unknown", code: "SANDBOX_JOB_DEADLINE" };
    if (outcome.state === "unknown") {
        killed ??= await kill(runtime, ctx, job.providerJobId, job);
        // Before the deadline, retry an uncertain kill with the same bounded
        // backoff. At the deadline, one bounded final attempt ends the chain
        // even if the provider never acknowledges cancellation.
        if (!killed && Date.now() < job.deadline)
            outcome = { state: "running" };
        else if (Date.now() >= job.deadline)
            outcome = { ...outcome, code: "SANDBOX_JOB_DEADLINE" };
    }
    return outcome;
}
