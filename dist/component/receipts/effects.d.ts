/**
 * Effect receipts behind `defineOnceTool`: the registered `begin`,
 * `complete` and `unknown` endpoints with their claim/lease protocol, plus
 * the `purge` chain for every expiring receipt.
 *
 * A paid or external effect claims its `(scope, key)` receipt with `begin`
 * (`beginEffect`: replay a recorded outcome, report a live claim, or hand out
 * a fresh fencing claim with a lease), then records `complete`
 * (`completeEffect`, only for the current claim inside its lease) or
 * `unknown`. Paid work is never retried automatically: an expired lease or a
 * transport error becomes `unknown`, never a fresh claim (unless the tool is
 * repeat-safe). An optional assignment fence ties the effect to the turn
 * that started it. Request/response receipts are written by turns/send.ts and
 * turns/approvals.ts. `purge` deletes expired receipts in bounded batches and
 * reschedules itself only while expiring receipts remain. Table: `receipts`;
 * reads `assignments`.
 */
import { type Value } from "convex/values";
import { type MutationCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
/** A receipt only carries its fencing token and lease while running; every
 * transition out of running spreads this to drop them, and a late holder's
 * claim then no longer matches anything. */
export declare const unclaimed: {
    readonly claim: undefined;
    readonly leaseUntil: undefined;
};
/** The optional turn fence on ledger calls: when an assignment is named, the
 * caller must still own its running turn at this token and epoch. */
export type TurnFence = {
    assignmentId?: Id<"assignments">;
    executionId?: string;
    cancellationEpoch?: number;
};
/** False when the call names an assignment whose turn it no longer owns. */
export declare function fenceHolds(ctx: MutationCtx, fence: TurnFence): Promise<boolean>;
/** Claim `(scope, key)` for one effect attempt, or report why not: a
 * recorded outcome to replay, a live claim, a fingerprint conflict, an
 * `unknown` outcome (never re-run unless `repeatSafe`), or a stale turn. */
export declare function beginEffect(ctx: MutationCtx, args: TurnFence & {
    scope: string;
    key: string;
    fingerprint: string;
    repeatSafe?: boolean;
    leaseMs?: number;
}): Promise<{
    status: "stale";
    code?: undefined;
    result?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "conflict";
    code: "KEY_CONFLICT";
    result?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "failed" | "done";
    result: any;
    code?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "running";
    code?: undefined;
    result?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "unknown";
    code?: undefined;
    result?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "claimed";
    claim: `${string}-${string}-${string}-${string}-${string}`;
    leaseUntil: number;
    code?: undefined;
    result?: undefined;
}>;
/** Record the outcome of the current claim. A stale claim is ignored; a
 * claim whose lease already expired becomes `unknown` instead. */
export declare function completeEffect(ctx: MutationCtx, args: TurnFence & {
    scope: string;
    key: string;
    claim: string;
    failed?: boolean;
    result: Value;
}): Promise<null>;
/** Claim an effect, or replay/refuse it; see `beginEffect`. */
export declare const begin: import("convex/server").RegisteredMutation<"public", {
    leaseMs?: number | undefined;
    assignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
    executionId?: string | undefined;
    cancellationEpoch?: number | undefined;
    repeatSafe?: boolean | undefined;
    key: string;
    scope: string;
    fingerprint: string;
}, Promise<{
    status: "stale";
    code?: undefined;
    result?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "conflict";
    code: "KEY_CONFLICT";
    result?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "failed" | "done";
    result: any;
    code?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "running";
    code?: undefined;
    result?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "unknown";
    code?: undefined;
    result?: undefined;
    claim?: undefined;
    leaseUntil?: undefined;
} | {
    status: "claimed";
    claim: `${string}-${string}-${string}-${string}-${string}`;
    leaseUntil: number;
    code?: undefined;
    result?: undefined;
}>>;
/** Record the current claim's outcome (or `unknown` after its lease). */
export declare const complete: import("convex/server").RegisteredMutation<"public", {
    failed?: boolean | undefined;
    assignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
    executionId?: string | undefined;
    cancellationEpoch?: number | undefined;
    result: any;
    key: string;
    scope: string;
    claim: string;
}, Promise<null>>;
/** Bounded indexed TTL work: never scan the entire ledger in a mutation. */
export declare const purge: import("convex/server").RegisteredMutation<"internal", {}, Promise<null>>;
/** A transport failure may have happened after provider admission. Preserve an
 * honest unknown outcome and never make that receipt eligible for paid replay.
 * One indexed receipt read + one <=64 KiB patch, independent of journal size. */
export declare const unknown: import("convex/server").RegisteredMutation<"public", {
    assignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
    executionId?: string | undefined;
    cancellationEpoch?: number | undefined;
    key: string;
    scope: string;
    claim: string;
}, Promise<null>>;
