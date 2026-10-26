/**
 * Argument validators shared by the stable charges registrations and handlers.
 * These are the existing wire contracts, kept together to infer helper inputs
 * without a type dependency on the generated component API. No functions are
 * registered here; every public/internal path remains in charges.ts.
 */
import { type Infer } from "convex/values";
/** Existing create arguments shared by its registration and transaction handler. */
export declare const createArgs: import("convex/values").VObject<{
    reason?: "NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined;
    credits?: number | undefined;
    nanos?: number | undefined;
    profile?: string | undefined;
    quantity?: number | undefined;
    status: "unknown" | "estimate" | "settled" | "corrected";
    key: string;
    provider: string;
    source: "lookup" | "estimate" | "inline" | "settlement";
    attribution: {
        agent?: string | undefined;
        threadId?: string | undefined;
        runId?: string | undefined;
        model?: string | undefined;
        rootThreadId?: string | undefined;
        subject: string;
    };
    breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
    maxThreadCharges: number;
    sinks: string[];
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
}, {
    key: import("convex/values").VString<string, "required">;
    attribution: import("convex/values").VObject<{
        agent?: string | undefined;
        threadId?: string | undefined;
        runId?: string | undefined;
        model?: string | undefined;
        rootThreadId?: string | undefined;
        subject: string;
    }, {
        subject: import("convex/values").VString<string, "required">;
        rootThreadId: import("convex/values").VString<string | undefined, "optional">;
        threadId: import("convex/values").VString<string | undefined, "optional">;
        runId: import("convex/values").VString<string | undefined, "optional">;
        agent: import("convex/values").VString<string | undefined, "optional">;
        model: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "agent" | "threadId" | "runId" | "subject" | "model" | "rootThreadId">;
    provider: import("convex/values").VString<string, "required">;
    breakdowns: import("convex/values").VArray<("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[], import("convex/values").VUnion<"thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider", [import("convex/values").VLiteral<"thread.model", "required">, import("convex/values").VLiteral<"thread.provider", "required">, import("convex/values").VLiteral<"subject.agent", "required">, import("convex/values").VLiteral<"subject.model", "required">, import("convex/values").VLiteral<"subject.provider", "required">], "required", never>, "required">;
    profile: import("convex/values").VString<string | undefined, "optional">;
    quantity: import("convex/values").VFloat64<number | undefined, "optional">;
    status: import("convex/values").VUnion<"unknown" | "estimate" | "settled" | "corrected", [import("convex/values").VLiteral<"estimate", "required">, import("convex/values").VLiteral<"settled", "required">, import("convex/values").VLiteral<"corrected", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
    source: import("convex/values").VUnion<"lookup" | "estimate" | "inline" | "settlement", [import("convex/values").VLiteral<"estimate", "required">, import("convex/values").VLiteral<"inline", "required">, import("convex/values").VLiteral<"settlement", "required">, import("convex/values").VLiteral<"lookup", "required">], "required", never>;
    nanos: import("convex/values").VFloat64<number | undefined, "optional">;
    credits: import("convex/values").VFloat64<number | undefined, "optional">;
    reason: import("convex/values").VUnion<"NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined, [import("convex/values").VLiteral<"NO_COST", "required">, import("convex/values").VLiteral<"DECODE_FAILED", "required">, import("convex/values").VLiteral<"INVALID_COST", "required">, import("convex/values").VLiteral<"OVER_CAP", "required">, import("convex/values").VLiteral<"PROVIDER_NOT_REGISTERED", "required">, import("convex/values").VLiteral<"PROFILE_NOT_REGISTERED", "required">, import("convex/values").VLiteral<"THREAD_CAPACITY", "required">], "optional", never>;
    sinks: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
    maxThreadCharges: import("convex/values").VFloat64<number, "required">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
}, "required", "status" | "key" | "reason" | "provider" | "source" | "attribution" | "credits" | "nanos" | "breakdowns" | "profile" | "quantity" | "attribution.agent" | "attribution.threadId" | "attribution.runId" | "attribution.subject" | "attribution.model" | "attribution.rootThreadId" | "maxThreadCharges" | "sinks" | "jobs" | "jobs.maxAttempts" | "jobs.deliver" | "jobs.lookup">;
export type CreateArgs = Infer<typeof createArgs>;
/** Existing update arguments shared by its registration and transaction handler. */
export declare const updateArgs: import("convex/values").VObject<{
    credits?: number | undefined;
    quantity?: number | undefined;
    key: string;
    operation: "settle" | "correct";
    nanos: number;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    operationKey: string;
}, {
    key: import("convex/values").VString<string, "required">;
    operation: import("convex/values").VUnion<"settle" | "correct", [import("convex/values").VLiteral<"correct", "required">, import("convex/values").VLiteral<"settle", "required">], "required", never>;
    operationKey: import("convex/values").VString<string, "required">;
    quantity: import("convex/values").VFloat64<number | undefined, "optional">;
    nanos: import("convex/values").VFloat64<number, "required">;
    credits: import("convex/values").VFloat64<number | undefined, "optional">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
}, "required", "key" | "operation" | "credits" | "nanos" | "quantity" | "jobs" | "jobs.maxAttempts" | "jobs.deliver" | "jobs.lookup" | "operationKey">;
export type UpdateArgs = Infer<typeof updateArgs>;
/** Existing attach arguments shared by its registration and transaction handler. */
export declare const attachArgs: import("convex/values").VObject<{
    key: string;
    lookupMs: number;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    operationKey: string;
    requestId: string;
}, {
    key: import("convex/values").VString<string, "required">;
    operationKey: import("convex/values").VString<string, "required">;
    requestId: import("convex/values").VString<string, "required">;
    lookupMs: import("convex/values").VFloat64<number, "required">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
}, "required", "key" | "lookupMs" | "jobs" | "jobs.maxAttempts" | "jobs.deliver" | "jobs.lookup" | "operationKey" | "requestId">;
export type AttachArgs = Infer<typeof attachArgs>;
/** Existing expire arguments shared by its registration and transaction handler. */
export declare const expireArgs: import("convex/values").VObject<{
    id: import("convex/values").GenericId<"charges">;
}, {
    id: import("convex/values").VId<import("convex/values").GenericId<"charges">, "required">;
}, "required", "id">;
export type ExpireArgs = Infer<typeof expireArgs>;
/** Existing lookupResult arguments shared by its registration and transaction handler. */
export declare const lookupResultArgs: import("convex/values").VObject<{
    credits?: number | undefined;
    nanos?: number | undefined;
    key: string;
    provider: string;
    attempt: number;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    requestId: string;
    until: number;
}, {
    nanos: import("convex/values").VFloat64<number | undefined, "optional">;
    credits: import("convex/values").VFloat64<number | undefined, "optional">;
    key: import("convex/values").VString<string, "required">;
    provider: import("convex/values").VString<string, "required">;
    requestId: import("convex/values").VString<string, "required">;
    until: import("convex/values").VFloat64<number, "required">;
    attempt: import("convex/values").VFloat64<number, "required">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
}, "required", "key" | "provider" | "credits" | "attempt" | "nanos" | "jobs" | "jobs.maxAttempts" | "jobs.deliver" | "jobs.lookup" | "requestId" | "until">;
export type LookupResultArgs = Infer<typeof lookupResultArgs>;
/** Existing claimDeliveries arguments shared by its registration and transaction handler. */
export declare const claimDeliveriesArgs: import("convex/values").VObject<{
    claim: string;
    sink: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
}, {
    sink: import("convex/values").VString<string, "required">;
    claim: import("convex/values").VString<string, "required">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
}, "required", "claim" | "sink" | "jobs" | "jobs.maxAttempts" | "jobs.deliver" | "jobs.lookup">;
export type ClaimDeliveriesArgs = Infer<typeof claimDeliveriesArgs>;
/** Existing deliveryResult arguments shared by its registration and transaction handler. */
export declare const deliveryResultArgs: import("convex/values").VObject<{
    retryAfterMs?: number | undefined;
    keys: string[];
    claim: string;
    ok: boolean;
    sink: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    rateLimited: boolean;
}, {
    sink: import("convex/values").VString<string, "required">;
    claim: import("convex/values").VString<string, "required">;
    keys: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
    ok: import("convex/values").VBoolean<boolean, "required">;
    retryAfterMs: import("convex/values").VFloat64<number | undefined, "optional">;
    rateLimited: import("convex/values").VBoolean<boolean, "required">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
}, "required", "keys" | "claim" | "ok" | "sink" | "jobs" | "jobs.maxAttempts" | "jobs.deliver" | "jobs.lookup" | "retryAfterMs" | "rateLimited">;
export type DeliveryResultArgs = Infer<typeof deliveryResultArgs>;
/** Existing deliveryComplete arguments shared by its registration and transaction handler. */
export declare const deliveryCompleteArgs: import("convex/values").VObject<{
    result: {
        kind: "failed";
        error: string;
    } | {
        kind: "canceled";
    } | {
        kind: "success";
        returnValue: any;
    };
    context: {
        claim: string;
        sink: string;
        jobs: {
            deliver?: string | undefined;
            lookup?: string | undefined;
            maxAttempts: number;
        };
        crashes: number;
    };
    workId: import("@convex-dev/workpool").WorkId;
}, {
    workId: import("convex/values").VString<import("@convex-dev/workpool").WorkId, "required">;
    context: import("convex/values").VObject<{
        claim: string;
        sink: string;
        jobs: {
            deliver?: string | undefined;
            lookup?: string | undefined;
            maxAttempts: number;
        };
        crashes: number;
    }, {
        crashes: import("convex/values").VFloat64<number, "required">;
        sink: import("convex/values").VString<string, "required">;
        claim: import("convex/values").VString<string, "required">;
        jobs: import("convex/values").VObject<{
            deliver?: string | undefined;
            lookup?: string | undefined;
            maxAttempts: number;
        }, {
            lookup: import("convex/values").VString<string | undefined, "optional">;
            deliver: import("convex/values").VString<string | undefined, "optional">;
            maxAttempts: import("convex/values").VFloat64<number, "required">;
        }, "required", "maxAttempts" | "deliver" | "lookup">;
    }, "required", "claim" | "sink" | "jobs" | "jobs.maxAttempts" | "jobs.deliver" | "jobs.lookup" | "crashes">;
    result: import("convex/values").VUnion<{
        kind: "failed";
        error: string;
    } | {
        kind: "canceled";
    } | {
        kind: "success";
        returnValue: any;
    }, [import("convex/values").VObject<{
        kind: "success";
        returnValue: any;
    }, {
        kind: import("convex/values").VLiteral<"success", "required">;
        returnValue: import("convex/values").VAny<any, "required", string>;
    }, "required", "kind" | "returnValue" | `returnValue.${string}`>, import("convex/values").VObject<{
        kind: "failed";
        error: string;
    }, {
        kind: import("convex/values").VLiteral<"failed", "required">;
        error: import("convex/values").VString<string, "required">;
    }, "required", "kind" | "error">, import("convex/values").VObject<{
        kind: "canceled";
    }, {
        kind: import("convex/values").VLiteral<"canceled", "required">;
    }, "required", "kind">], "required", "kind" | "returnValue" | `returnValue.${string}` | "error">;
}, "required", "result" | "context" | "workId" | "result.kind" | "result.returnValue" | `result.returnValue.${string}` | "result.error" | "context.claim" | "context.sink" | "context.jobs" | "context.jobs.maxAttempts" | "context.jobs.deliver" | "context.jobs.lookup" | "context.crashes">;
export type DeliveryCompleteArgs = Infer<typeof deliveryCompleteArgs>;
/** Existing retrySinks arguments shared by its registration and transaction handler. */
export declare const retrySinksArgs: import("convex/values").VObject<{
    key: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
}, {
    key: import("convex/values").VString<string, "required">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
}, "required", "key" | "jobs" | "jobs.maxAttempts" | "jobs.deliver" | "jobs.lookup">;
export type RetrySinksArgs = Infer<typeof retrySinksArgs>;
/** Existing prune arguments shared by its registration and transaction handler. */
export declare const pruneArgs: import("convex/values").VObject<{
    limit?: number | undefined;
    before: number;
    minAgeMs: number;
}, {
    before: import("convex/values").VFloat64<number, "required">;
    limit: import("convex/values").VFloat64<number | undefined, "optional">;
    minAgeMs: import("convex/values").VFloat64<number, "required">;
}, "required", "before" | "limit" | "minAgeMs">;
export type PruneArgs = Infer<typeof pruneArgs>;
