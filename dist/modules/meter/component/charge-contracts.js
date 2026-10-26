/**
 * Argument validators shared by the stable charges registrations and handlers.
 * These are the existing wire contracts, kept together to infer helper inputs
 * without a type dependency on the generated component API. No functions are
 * registered here; every public/internal path remains in charges.ts.
 */
import { v } from "convex/values";
import { vOnCompleteArgs } from "@convex-dev/workpool";
import { attribution, status, source, breakdowns, reason } from "./schema.js";
import { jobs, lookupJob, deliveryJob } from "../shared/contracts.js";
/** Existing create arguments shared by its registration and transaction handler. */
export const createArgs = v.object({
    key: v.string(),
    attribution,
    provider: v.string(),
    breakdowns,
    profile: v.optional(v.string()),
    quantity: v.optional(v.number()),
    status,
    source,
    nanos: v.optional(v.number()),
    credits: v.optional(v.number()),
    reason: v.optional(reason),
    sinks: v.array(v.string()),
    maxThreadCharges: v.number(),
    jobs,
});
/** Existing update arguments shared by its registration and transaction handler. */
export const updateArgs = v.object({
    key: v.string(),
    operation: v.union(v.literal("correct"), v.literal("settle")),
    operationKey: v.string(),
    quantity: v.optional(v.number()),
    nanos: v.number(),
    credits: v.optional(v.number()),
    jobs,
});
/** Existing attach arguments shared by its registration and transaction handler. */
export const attachArgs = v.object({
    key: v.string(),
    operationKey: v.string(),
    requestId: v.string(),
    lookupMs: v.number(),
    jobs,
});
/** Existing expire arguments shared by its registration and transaction handler. */
export const expireArgs = v.object({ id: v.id("charges") });
/** Existing lookupResult arguments shared by its registration and transaction handler. */
export const lookupResultArgs = v.object({
    ...lookupJob,
    nanos: v.optional(v.number()),
    credits: v.optional(v.number()),
});
/** Existing claimDeliveries arguments shared by its registration and transaction handler. */
export const claimDeliveriesArgs = v.object(deliveryJob);
/** Existing deliveryResult arguments shared by its registration and transaction handler. */
export const deliveryResultArgs = v.object({
    sink: v.string(),
    claim: v.string(),
    keys: v.array(v.string()),
    ok: v.boolean(),
    retryAfterMs: v.optional(v.number()),
    rateLimited: v.boolean(),
    jobs,
});
/** Existing deliveryComplete arguments shared by its registration and transaction handler. */
export const deliveryCompleteArgs = vOnCompleteArgs(v.object({ ...deliveryJob, crashes: v.number() }));
/** Existing retrySinks arguments shared by its registration and transaction handler. */
export const retrySinksArgs = v.object({ key: v.string(), jobs });
/** Existing prune arguments shared by its registration and transaction handler. */
export const pruneArgs = v.object({
    before: v.number(),
    limit: v.optional(v.number()),
    minAgeMs: v.number(),
});
