/** Evidence failure containment. Paid outcomes never depend on usage-hook availability;
 * a sticky core marker keeps later reporting partial even after the hook recovers.
 */
import type { RuntimeContext } from "../registration/context.js";
import type { Turn } from "./context.js";
/** Failure of the marker itself is best effort too, never a reason to repeat work. */
export declare function markUsagePartial(rt: RuntimeContext, turn: Turn): Promise<void>;
