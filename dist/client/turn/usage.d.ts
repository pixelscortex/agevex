/** Evidence failure containment. Paid outcomes never depend on meter availability;
 * a sticky core marker keeps later reporting partial even after the meter recovers.
 */
import type { MeterBackend } from "../slots.js";
import type { RuntimeContext } from "../registration/context.js";
import type { Turn } from "./context.js";
/** Failure of the marker itself is best effort too, never a reason to repeat work. */
export declare function markUsagePartial(rt: RuntimeContext, turn: Turn): Promise<void>;
/** Wrap charge operations as well as creation: a late attach/settle failure must
 * not turn a successful paid tool into a retryable tool error. */
export declare function failOpenMeter(scope: () => MeterBackend, failed: () => Promise<void>): MeterBackend;
/** Every slice exit triggers an idempotent bounded sweep. This includes early
 * child completion and cancellation; no root-lifecycle inference is needed. */
export declare function reconcileUsage(rt: RuntimeContext, turn: Turn): Promise<void>;
