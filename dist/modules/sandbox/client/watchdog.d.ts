/**
 * Host wake, poll, settlement and on-demand cleanup registrations.
 * The component job claim atomically persists a watchdog before scheduling a poll.
 * Only safe status reads retry; deadlines and late-attempt bounds end every chain.
 */
import { type PollArgs, type PollActionArgs, type SettleArgs } from "./types.js";
import { type RuntimeContext } from "./runtime-context.js";
/** Compose the finite watchdog and cleanup host registrations. */
export declare function internalFunctions(runtime: RuntimeContext): {
    wake: import("convex/server").RegisteredMutation<"internal", PollArgs, Promise<null>>;
    poll: import("convex/server").RegisteredAction<"internal", PollActionArgs, Promise<null>>;
    settle: import("convex/server").RegisteredMutation<"internal", SettleArgs, Promise<null>>;
    cleanup: import("convex/server").RegisteredAction<"internal", {}, Promise<null>>;
};
/**
 * The scheduler only calls this mutation: claiming the job persists a lease
 * backstop atomically with scheduling the poll action. If that action dies,
 * the backstop retries; consuming a wake never leaves the job unscheduled.
 */
export declare function buildWake(runtime: RuntimeContext): import("convex/server").RegisteredMutation<"internal", PollArgs, Promise<null>>;
/** Poll the claimed job, retrying safe reads and callback settlement only within its deadline. */
export declare function buildPoll(runtime: RuntimeContext): import("convex/server").RegisteredAction<"internal", PollActionArgs, Promise<null>>;
/** Finish metadata and invoke the completion callback in one rollback-safe host transaction. */
export declare function buildSettle(runtime: RuntimeContext): import("convex/server").RegisteredMutation<"internal", SettleArgs, Promise<null>>;
/** Drain one bounded TTL batch on demand, deferring deletes that cannot fit the action budget. */
export declare function buildCleanup(runtime: RuntimeContext): import("convex/server").RegisteredAction<"internal", {}, Promise<null>>;
