// Workflow journal assertions for tests, exported as `expectJournalUnchanged` from
// `agevex/test`.
//
// A Workflow replays its journal on every step, so any change to the order, names
// or arguments of the steps a turn records breaks in-flight workflows. Tests call
// `expectJournalUnchanged` with a committed fixture: it compares the normalized
// journal (`journal.ts` `turns`) and then replays every recorded turn through
// Workflow's real engine (`clone` / `result`). `workflowCall` reaches those
// test-only functions through the `agevexTest` bridge (`bridge.ts`).
import { REPLAY_BOUNDARY } from "./journal.js";
import { componentsGeneric, } from "convex/server";
/** Address nested functions through a real test-only component forwarding mutation/query. */
export async function workflowCall(t, path, type, module, name, args = {}) {
    const [component, lane] = path.split("/");
    const payload = { lane, module, name, args };
    if (type === "query")
        return t.query(componentsGeneric()[component].agevexTest.read, payload);
    return t.mutation(componentsGeneric()[component].agevexTest.write, payload);
}
/**
 * Compare persisted step names, kinds, arguments and results with a committed
 * fixture, then execute each recorded turn through Workflow's real replay
 * engine. A clone keeps the original callback from notifying its parent again.
 * No historical action may run: replay must consume every recorded step.
 */
export async function expectJournalUnchanged(t, path, fixture) {
    const turns = await workflowCall(t, path, "query", "agevexJournal", "turns");
    const normalized = turns.map(normalizeTurn);
    if (canonical(normalized) !== canonical(fixture))
        throw new Error(`Workflow journal changed. Expected ${JSON.stringify(fixture)}; recorded ${JSON.stringify(normalized)}`);
    for (const turn of turns)
        await expectReplay(t, path, turn);
}
/**
 * One turn's journal with its run-specific ids replaced by `$execution` /
 * `$assignment`, so fixtures compare across runs.
 */
function normalizeTurn(turn) {
    const replace = (value) => {
        if (typeof value === "string")
            return (turn.args.executionId ? value.replaceAll(turn.args.executionId, "$execution") : value).replaceAll(turn.args.assignmentId, "$assignment");
        if (Array.isArray(value))
            return value.map(replace);
        if (value && typeof value === "object")
            return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, replace(v)]));
        return value;
    };
    return {
        kind: turn.kind,
        version: turn.args.version,
        steps: turn.steps.map((step) => replace({
            kind: step.kind,
            name: step.name,
            functionType: step.functionType,
            args: step.args,
            runResult: step.runResult,
        })),
    };
}
/**
 * Canonical JSON for the comparison.
 *
 * Object key order does not matter to the comparison, but array/step order
 * does. This catches argument drift as well as inserted or reordered steps.
 */
function canonical(value) {
    return JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v);
}
/**
 * Replay one recorded turn from a clone. A turn workflow must succeed; the loop
 * workflow must stop exactly at the `REPLAY_BOUNDARY` sentinel.
 */
async function expectReplay(t, path, turn) {
    const replayId = await workflowCall(t, path, "mutation", "agevexJournal", "clone", {
        workflowId: turn.id,
    });
    const result = await workflowCall(t, path, "query", "agevexJournal", "result", { workflowId: replayId });
    if (turn.kind === "loop"
        ? result?.kind !== "failed" || !result.error?.includes(REPLAY_BOUNDARY)
        : result?.kind !== "success")
        throw new Error(`Workflow replay failed: ${JSON.stringify(result)}`);
}
