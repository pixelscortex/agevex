/** Return one charge with bounded delivery state; callers authorize in the host client. */
export declare const get: import("convex/server").RegisteredQuery<"public", {
    key: string;
}, Promise<import("./charge-records.js").Outcome | null>>;
/** Admit or replay an immutable charge key and update its aggregate/outbox state. */
export declare const create: import("convex/server").RegisteredMutation<"public", {
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
}, Promise<null>>;
/** Apply one idempotent correction or authoritative settlement. */
export declare const update: import("convex/server").RegisteredMutation<"public", {
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
}, Promise<import("./charge-records.js").Outcome>>;
/** Attach provider evidence identity and schedule its bounded lookup window. */
export declare const attach: import("convex/server").RegisteredMutation<"public", {
    key: string;
    lookupMs: number;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    operationKey: string;
    requestId: string;
}, Promise<import("./charge-records.js").Outcome>>;
/** One-shot deadline for unresolved lookup evidence. */
export declare const expire: import("convex/server").RegisteredMutation<"internal", {
    id: import("convex/values").GenericId<"charges">;
}, Promise<void>>;
/** Fence read-only lookup callbacks and retain authoritative billing evidence. */
export declare const lookupResult: import("convex/server").RegisteredMutation<"public", {
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
}, Promise<null>>;
/** Claim one bounded sink batch without reading large charge documents. */
export declare const claimDeliveries: import("convex/server").RegisteredMutation<"public", {
    claim: string;
    sink: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
}, Promise<({
    externalId: string;
    revision: number;
    nanos: number;
    totalNanos: number;
} & Pick<{
    _id: import("convex/values").GenericId<"deliveries">;
    _creationTime: number;
    claim?: string | undefined;
    failed: boolean;
    event: {
        externalId: string;
        revision: number;
        nanos: number;
        totalNanos: number;
    };
    attempts: number;
    key: string;
    provider: string;
    attribution: {
        agent?: string | undefined;
        threadId?: string | undefined;
        runId?: string | undefined;
        model?: string | undefined;
        rootThreadId?: string | undefined;
        subject: string;
    };
    sink: string;
    limited: boolean;
    dueAt: number;
}, "key" | "provider" | "attribution">)[]>>;
/** Acknowledge a bounded claimed batch or record its failed attempt. */
export declare const deliveryResult: import("convex/server").RegisteredMutation<"public", {
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
}, Promise<null>>;
/** Workpool completion fence for delivery crashes and claim cleanup. */
export declare const deliveryComplete: import("convex/server").RegisteredMutation<"internal", {
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
}, Promise<null>>;
/** Explicitly retry pending sink events without stealing in-flight claims. */
export declare const retrySinks: import("convex/server").RegisteredMutation<"public", {
    key: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
}, Promise<null>>;
/** Prune terminal charges under conservative transaction budgets. */
export declare const prune: import("convex/server").RegisteredMutation<"public", {
    limit?: number | undefined;
    before: number;
    minAgeMs: number;
}, Promise<{
    deleted: number;
    more: boolean;
}>>;
