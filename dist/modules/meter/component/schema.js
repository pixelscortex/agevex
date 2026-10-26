/**
 * Meter component tables and shared charge validators.
 * Charges own immutable attribution, pricing, bounded operation receipts and
 * per-sink event snapshots; deliveries hold small retryable outbox rows.
 * Claims distinguish delivery jobs that took a batch from pre-claim crashes.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export const attribution = v.object({
    subject: v.string(),
    rootThreadId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    runId: v.optional(v.string()),
    agent: v.optional(v.string()),
    model: v.optional(v.string()),
    purpose: v.optional(v.union(v.literal("agent"), v.literal("hook"), v.literal("tool"), v.literal("title"), v.literal("summary"))),
    nodeId: v.optional(v.string()),
});
export const tokens = v.object({ inputTokens: v.number(), outputTokens: v.number() });
export const reconciliation = v.union(v.literal("pending"), v.literal("running"), v.literal("complete"), v.literal("unavailable"), v.literal("exhausted"));
export const status = v.union(v.literal("estimate"), v.literal("settled"), v.literal("corrected"), v.literal("unknown"));
export const source = v.union(v.literal("estimate"), v.literal("inline"), v.literal("settlement"), v.literal("lookup"));
export const breakdowns = v.array(v.union(v.literal("thread.model"), v.literal("thread.provider"), v.literal("subject.agent"), v.literal("subject.model"), v.literal("subject.provider")));
export const event = v.object({
    externalId: v.string(),
    revision: v.number(),
    nanos: v.number(),
    totalNanos: v.number(),
    // Optional because outbox rows and pending events written before
    // classification was recorded lack them; claims fill them in (delivery.ts).
    status: v.optional(status),
    source: v.optional(source),
});
/** Why a charge was created `unknown`. Set once at creation, kept after a later settlement. */
export const reason = v.union(v.literal("NO_COST"), v.literal("DECODE_FAILED"), v.literal("INVALID_COST"), v.literal("OVER_CAP"), v.literal("PROVIDER_NOT_REGISTERED"), v.literal("PROFILE_NOT_REGISTERED"), v.literal("THREAD_CAPACITY"));
const sinkFields = {
    name: v.string(),
    // Registration is frozen per charge, just like projection membership.
    // Optional: charges created before opt-ins existed read as not opted in.
    estimates: v.optional(v.boolean()),
    deliveredNanos: v.optional(v.number()),
    deliveredStatus: v.optional(status),
    deliveredSource: v.optional(source),
    revision: v.number(),
    pending: v.optional(event),
};
/** Stored on the charge: registration and acknowledged/pending amount and classification. */
export const sinkState = v.array(v.object(sinkFields));
/** Returned to callers: retry state joined from the charge's <=4 `deliveries` rows. */
export const sinkView = v.array(v.object({ ...sinkFields, attempts: v.number(), failed: v.boolean() }));
// Receipt outcomes deliberately exclude the receipt ledger, preventing recursive
// snapshots and keeping every saved result bounded independently of operation count.
const chargeFields = {
    key: v.string(),
    attribution,
    provider: v.string(),
    // Freeze projection membership at creation: later opt-ins must not insert
    // historical charges, and workers must replace exactly the entries that exist.
    breakdowns,
    profile: v.optional(v.string()),
    quantity: v.optional(v.number()),
    status,
    source,
    nanos: v.optional(v.number()),
    credits: v.optional(v.number()),
    providerRequestId: v.optional(v.string()),
    tokens: v.optional(tokens),
    reconciliation: v.optional(reconciliation),
    lookupUntil: v.optional(v.number()),
    // Amount revisions describe outcomes; replay identity comes from operation keys.
    revision: v.number(),
    lastStale: v.optional(v.object({ operation: v.string(), revision: v.number() })),
    lookupAttempt: v.optional(v.number()),
    reason: v.optional(reason),
};
export default defineSchema({
    charges: defineTable({
        ...chargeFields,
        sinkState,
        // Settled with every sink acknowledged (or no sinks): the only rows prune
        // may delete. Indexed so retention never scans live or undelivered charges.
        terminal: v.boolean(),
        operations: v.array(v.object({
            key: v.string(),
            outcome: v.object({
                ...chargeFields,
                sinkState: sinkView,
                _id: v.id("charges"),
                _creationTime: v.number(),
            }),
        })),
    })
        .index("by_key", ["key"])
        .index("by_run_lookup", ["attribution.subject", "attribution.runId", "reconciliation"])
        .index("by_terminal", ["terminal"]),
    /**
     * Sink outbox: one small row per pending (charge, sink) event, present
     * exactly while that sink's `pending` is set on the charge. It carries the
     * event payload so one delivery job reads <=100 rows of <=3 KiB instead of
     * <=100 charges of up to 280 KiB, and it holds retry state so crash and
     * failure accounting never rewrites large charge rows.
     */
    deliveries: defineTable({
        sink: v.string(),
        key: v.string(),
        event,
        attribution,
        provider: v.string(),
        attempts: v.number(),
        // The previous failure was a 429 that did not consume an attempt.
        limited: v.boolean(),
        failed: v.boolean(),
        dueAt: v.number(),
        // The delivery job currently holding this event; unset while due.
        claim: v.optional(v.string()),
    })
        .index("by_key", ["key", "sink"])
        .index("by_due", ["sink", "failed", "claim", "dueAt"])
        .index("by_claim", ["claim"]),
    /** One marker per delivery job that has claimed its batch; deleted by the
     * job's onComplete. It distinguishes "claimed, then died" from "died before
     * claiming" after all claimed rows were acknowledged and deleted. */
    claims: defineTable({ claim: v.string() }).index("by_claim", ["claim"]),
});
