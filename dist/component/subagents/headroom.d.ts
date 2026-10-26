/** Shared admission reservations: optional work cannot spend an owed result or answer hop. */
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
type Spend = "note" | "ask" | "message" | "answer" | "launch";
/** H + 1 + pending results + open answers + reservation delta <= runHops.
 * A launch adds its own future result; an ask adds its eventual answer;
 * an answer consumes an existing reservation. Settlement releases activeRuns
 * before delivery, so only deliveryStatus can identify every owed result.
 * Side results are free, but side questions still need their answer hop.
 * Every count is scoped to this budget and the current cancellation epoch.
 * <=58 budget rows *4 KiB =232 KiB /58 reads per pass. Five note
 * admission passes add <=1,160 KiB /290 reads; the native-save transaction
 * remains <8 MiB /1,000 reads. Queue admission needs only the target counter.
 */
export declare function reserveFor(ctx: QueryCtx | MutationCtx, kind: Spend, root: Doc<"assignments">, budget: Doc<"runs">): Promise<{
    kind: "denied";
    code: "RUN_BUDGET";
} | null>;
/** Bound outstanding result work on ONE assignment, across user budgets.
 * runLaunches alone only bounds a single request: a root can process another
 * user prompt while old children or sealed joins still owe results. Admission
 * counts pending ordinary deliveries, unreleased join members and ready result
 * rows. Delivery replaces a pending member with a row; a joined row replaces
 * its members; claim removes work. Only launch can increase this total.
 * No queue slots are reserved and queueLength never gates a launch or result.
 * Four <=50 metadata ranges *4 KiB +152 ready ids *1 KiB <1 MiB;
 * the entire launch/native task-save transaction stays <4 MiB /512 reads.
 * Current-epoch index ranges exclude cancelled history without a prefix scan.
 */
export declare function canOweResult(ctx: MutationCtx, actor: Doc<"assignments">, root: Doc<"assignments">): Promise<boolean>;
export {};
