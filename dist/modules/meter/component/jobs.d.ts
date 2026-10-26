/**
 * Workpool admission and retry bounds for read-only lookup and sink delivery.
 * Charge lifecycle and outbox helpers call these inside their own transaction.
 * The pool never retries an action implicitly; each on-demand delivery job has
 * a unique claim whose completion callback remains registered in charges.ts.
 */
import { Workpool } from "@convex-dev/workpool";
import type { DefaultFunctionArgs, FunctionReference } from "convex/server";
import type { Infer } from "convex/values";
import type { MutationCtx } from "./_generated/server.js";
import { jobs } from "../shared/contracts.js";
export declare const pool: Workpool;
export type Jobs = Infer<typeof jobs>;
/** Workpool's runtime supports function handles; its enqueueAction type only names references.
 * src/client/index.ts:576-579 passes a function:// handle through unchanged. */
export declare function actionHandle<A extends DefaultFunctionArgs>(handle: string): FunctionReference<"action", "internal", A>;
/** Validate retry ceilings and opaque worker handles before any charge or outbox work. */
export declare function validateJobs(config: Jobs): void;
/**
 * Start one delivery job for a sink. The job drains up to LIMITS.sinkBatch due
 * events of that sink, so a burst shares requests; jobs that find nothing
 * claimed return without contacting the sink. `claim` identifies the rows the
 * job takes, so its Workpool onComplete can count a crash as a failed attempt.
 * `crashes` counts consecutive deaths before claiming (see deliveryComplete).
 * onComplete also runs on success, to delete the job's claim marker.
 */
export declare function enqueueDrain(ctx: MutationCtx, sink: string, config: Jobs, runAt: number, crashes?: number): Promise<void>;
/** Bound the delay when a read-only lookup or sink attempt is retried. */
export declare function backoff(attempts: number): number;
