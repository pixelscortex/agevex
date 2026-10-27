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
/** Claim an effect, or replay/refuse it; see `beginEffect`. */
export declare const begin: import("convex/server").RegisteredMutation<"public", {
    leaseMs?: number | undefined;
    executionId?: string | undefined;
    cancellationEpoch?: number | undefined;
    assignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
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
    executionId?: string | undefined;
    cancellationEpoch?: number | undefined;
    assignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
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
    executionId?: string | undefined;
    cancellationEpoch?: number | undefined;
    assignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
    key: string;
    scope: string;
    claim: string;
}, Promise<null>>;
