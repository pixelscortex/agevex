/**
 * Bounded outbox claims, acknowledgements and failure/crash accounting.
 * Registered delivery mutations in charges.ts delegate here in the same
 * transaction. Claim markers distinguish crashes before and after admission;
 * acknowledgements alone load charge rows, in bounded batches of at most 16.
 */
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import type { ClaimDeliveriesArgs, DeliveryResultArgs, DeliveryCompleteArgs, RetrySinksArgs } from "./charge_contracts.js";
type Delivery = Doc<"deliveries">;
type DeliveryEvent = Required<Delivery["event"]> & Pick<Delivery, "key" | "attribution" | "provider">;
/**
 * Called by the host delivery action. Takes <=100 due outbox rows of one sink
 * (<=3 KiB each: frozen amount/classification, seven 128-byte attribution
 * labels plus purpose, provider/sink labels and the key/external id):
 * <=300 KiB read and written, 100 docs. Never reads charge rows. The claim
 * marker records that this job took its batch, even after every row is
 * acknowledged and deleted, so a later crash charges only the job's own rows.
 */
export declare function claimDeliveryBatch(ctx: MutationCtx, args: ClaimDeliveriesArgs): Promise<DeliveryEvent[]>;
/**
 * Results for <=LIMITS.ackBatch events of one claimed batch. An acknowledgement
 * reads and rewrites its charge (<=280 KiB): 16 * 280 KiB =4.4 MiB read and
 * written, plus <=16 new outbox rows and Workpool admissions. Stale results
 * (a different claim holds the row, or it is gone) are ignored.
 */
export declare function recordDeliveryResult(ctx: MutationCtx, args: DeliveryResultArgs): Promise<null>;
/**
 * Workpool onComplete for every delivery job. It deletes the job's claim
 * marker. A failed or cancelled job that claimed counts as one failed attempt
 * for the rows still carrying its claim, exactly like deliveryResult(ok:false),
 * and charges no other row: a job that acknowledged its batch and then died
 * charges nothing. A job that died before claiming touched nothing, so it is
 * re-enqueued (no attempt charged) up to maxAttempts-1 consecutive times; the
 * last such crash charges one attempt to the sink's due rows (<=100).
 * Reads <=1 marker and <=100 outbox rows, never a charge row.
 */
export declare function completeDelivery(ctx: MutationCtx, { context, result }: DeliveryCompleteArgs): Promise<null>;
/** Reset only unclaimed pending sink events after an explicit host retry request. */
export declare function retryPendingSinks(ctx: MutationCtx, args: RetrySinksArgs): Promise<null>;
export {};
