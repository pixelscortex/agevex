import { v } from "convex/values";
import { event } from "./schema.js";

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
export const deliveryJob = { key: v.string(), sink: v.string(), event, jobs };
