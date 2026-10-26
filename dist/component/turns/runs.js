/** The fresh budget for one accepted send. `models` is the thread's model
 * policy at acceptance, snapshotted so later sends cannot change a live run. */
export function newRun(models) {
    return {
        models,
        // 64-bit agent-index masks: who started in this run / who owns routing.
        startedAgents: 0n,
        routingAgents: 0n,
        // Spend counters, each checked against its limits.ts bound.
        continues: 0,
        sideRuns: 0,
        launches: 0,
        hops: 0,
        cancelled: false,
    };
}
