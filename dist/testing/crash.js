/** Test-only Workpool fault injection. Production mounts none of these functions. */
import { internalMutationGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
/** Fail a real in-flight paid step via Workpool, including scheduler cancellation.
 * Offline tests invoke upstream recovery directly; the real local probe waits
 * for its unmodified cadence instead. Neither route calls agevex finalization.
 */
export const interrupt = internalMutationGeneric({
    args: { mode: v.union(v.literal("scheduler"), v.literal("failed"), v.literal("canceled")) },
    returns: v.number(),
    handler: async (ctx, { mode }) => {
        const state = await ctx.db.query("internalState").unique();
        let count = 0;
        for (const entry of state?.running ?? []) {
            const work = await ctx.db.get(entry.workId);
            if (work?.fnName !== "agentStep")
                continue;
            if (mode === "scheduler") {
                await ctx.scheduler.cancel(entry.scheduledId);
                await ctx.runMutation(makeFunctionReference("recovery:recover"), {
                    jobs: [{ ...entry, attempt: work.attempts }],
                });
            }
            else {
                await ctx.runMutation(makeFunctionReference("complete:complete"), {
                    jobs: [
                        {
                            workId: entry.workId,
                            attempt: work.attempts,
                            runResult: mode === "failed"
                                ? { kind: "failed", error: "killed paid action" }
                                : { kind: "canceled" },
                        },
                    ],
                });
            }
            count++;
        }
        return count;
    },
});
