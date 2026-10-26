import type { RuntimeContext } from "../registration/context.js";
import type { Turn } from "./context.js";
/** Start once and clear once, ordered even if start fails or finishes after the tool.
 * Neither edge blocks the tool. The action boundary owns their eventual settlement.
 */
export declare function startToolProgress(rt: RuntimeContext, turn: Turn, name: string, toolCallId: string): () => void;
/** Every claimed action exit drains progress, including failure, abort and stale
 * completion. Close unfinished streams/tools now: their late finally is a no-op
 * and cannot dispatch an RPC after the action returns. Start/clear use only local
 * hashing and one bounded Convex mutation each, with no retries or external I/O,
 * so await allSettled without a timeout that would abandon a live Convex operation.
 * Only two edges per admitted local call are retained; settled edges are removed
 * immediately, so this set never accumulates tool history.
 */
export declare function settleToolProgress(turn: Turn): Promise<void>;
