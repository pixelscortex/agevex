/** Best-effort progress RPCs belong to the slice action, never to a paid result. */
import { opaqueKey } from "../keys.js";
/** Observe failures immediately and retain only in-flight work, not tool history. */
function track(turn, work) {
    const pending = work.catch(() => { }).finally(() => turn.toolProgress.pending.delete(pending));
    turn.toolProgress.pending.add(pending);
    return pending;
}
/** Start once and clear once, ordered even if start fails or finishes after the tool.
 * Neither edge blocks the tool. The action boundary owns their eventual settlement.
 */
export function startToolProgress(rt, turn, name, toolCallId) {
    // An uncooperative provider/tool may resume after revocation and action cleanup.
    // Its existing execution fence owns the paid outcome; progress must dispatch nothing.
    if (turn.toolProgress.closed)
        return () => { };
    const { rawCtx, args, turnKey, toolProgress } = turn;
    const mark = rt.component.turns.tools.mark;
    let marker;
    const started = track(turn, Promise.resolve().then(async () => {
        marker = { ...args, key: await opaqueKey("tool-progress", turnKey, toolCallId) };
        await rawCtx.runMutation(mark, { ...marker, name });
    }));
    const clear = () => {
        if (!toolProgress.clear.delete(clear))
            return;
        void track(turn, started.then(async () => {
            if (marker)
                await rawCtx.runMutation(mark, marker);
        }));
    };
    toolProgress.clear.add(clear);
    return clear;
}
/** Every claimed action exit drains progress, including failure, abort and stale
 * completion. Close unfinished streams/tools now: their late finally is a no-op
 * and cannot dispatch an RPC after the action returns. Start/clear use only local
 * hashing and one bounded Convex mutation each, with no retries or external I/O,
 * so await allSettled without a timeout that would abandon a live Convex operation.
 * Only two edges per admitted local call are retained; settled edges are removed
 * immediately, so this set never accumulates tool history.
 */
export async function settleToolProgress(turn) {
    turn.toolProgress.closed = true;
    for (const clear of turn.toolProgress.clear)
        clear();
    await Promise.allSettled(turn.toolProgress.pending);
}
