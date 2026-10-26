/**
 * Wire contracts for host worker handles and component Workpool jobs.
 * Lookup jobs carry the immutable request, deadline and attempt fence.
 * Delivery jobs name one sink and claim, with retry bounds carried explicitly.
 * Both runtimes validate the same payload; no functions are registered here.
 */
import { v } from "convex/values";
export const jobs = v.object({
    lookup: v.optional(v.string()),
    deliver: v.optional(v.string()),
    maxAttempts: v.number(),
});
export const lookupJob = {
    key: v.string(),
    provider: v.string(),
    requestId: v.string(),
    until: v.number(),
    attempt: v.number(),
    jobs,
};
/** One delivery job drains one sink's due outbox rows; `claim` names its batch. */
export const deliveryJob = { sink: v.string(), claim: v.string(), jobs };
