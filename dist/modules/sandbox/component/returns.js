/** Return contracts reuse the stored schema so lifecycle responses cannot drift. */
import { v } from "convex/values";
import schema from "./schema.js";
export const sandboxDocument = v.object({
    ...schema.tables.sandboxes.validator.fields,
    _id: v.id("sandboxes"),
    _creationTime: v.number(),
});
export const jobDocument = v.object({
    ...schema.tables.jobs.validator.fields,
    _id: v.id("jobs"),
    _creationTime: v.number(),
});
export const reservation = v.union(v.object({ status: v.literal("claimed"), claim: v.string() }), v.object({ status: v.union(v.literal("running"), v.literal("unknown")) }), v.object({ status: v.literal("existing"), sandboxId: v.string(), claim: v.string() }));
export const jobReservation = v.object({
    jobId: v.id("jobs"),
    claim: v.string(),
    providerJobId: v.optional(v.string()),
    sandboxId: v.string(),
    directory: v.string(),
});
export const jobCompletion = v.object({
    type: v.literal("sandbox.job.completed"),
    jobId: v.id("jobs"),
    providerJobId: v.optional(v.string()),
    scopeKey: v.string(),
    subject: v.string(),
    threadId: v.string(),
    runId: v.string(),
    state: v.union(v.literal("done"), v.literal("failed"), v.literal("unknown")),
    exitCode: v.optional(v.number()),
    logTail: v.optional(v.string()),
    code: v.optional(v.literal("SANDBOX_JOB_DEADLINE")),
});
