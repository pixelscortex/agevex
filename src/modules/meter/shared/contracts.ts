// Pure shared contracts and bounds used by the host and component; no function registrations.
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
