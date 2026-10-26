/** Return one charge with bounded delivery state; callers authorize in the host client. */
export declare const get: import("convex/server").RegisteredQuery<"public", {
    key: string;
}, Promise<import("./charge-records.js").Outcome | null>>;
/** Admit or replay an immutable charge key and update its aggregate/outbox state. */
export declare const create: import("convex/server").RegisteredMutation<"public", {
    reason?: "NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined;
    requestId?: string | undefined;
    credits?: number | undefined;
    nanos?: number | undefined;
    profile?: string | undefined;
    quantity?: number | undefined;
    tokens?: {
        inputTokens: number;
        outputTokens: number;
    } | undefined;
    status: "unknown" | "estimate" | "settled" | "corrected";
    key: string;
    provider: string;
    source: "lookup" | "estimate" | "inline" | "settlement";
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    attribution: {
        agent?: string | undefined;
        runId?: string | undefined;
        threadId?: string | undefined;
        model?: string | undefined;
        rootThreadId?: string | undefined;
        purpose?: "agent" | "title" | "summary" | "tool" | "hook" | undefined;
        nodeId?: string | undefined;
        subject: string;
    };
    breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
    maxThreadCharges: number;
    sinks: {
        name: string;
        estimates: boolean;
    }[];
}, Promise<null>>;
/** Apply one idempotent correction or authoritative settlement. */
export declare const update: import("convex/server").RegisteredMutation<"public", {
    credits?: number | undefined;
    quantity?: number | undefined;
    key: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    operation: "settle" | "correct";
    nanos: number;
    operationKey: string;
}, Promise<import("./charge-records.js").Outcome>>;
/** Attach provider evidence identity and schedule its bounded lookup window. */
export declare const attach: import("convex/server").RegisteredMutation<"public", {
    key: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    requestId: string;
    lookupMs: number;
    operationKey: string;
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
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    requestId: string;
    attempt: number;
    until: number;
}, Promise<null>>;
/** Claim one bounded sink batch without reading large charge documents. */
export declare const claimDeliveries: import("convex/server").RegisteredMutation<"public", {
    claim: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    sink: string;
}, Promise<(Required<{
    status?: "unknown" | "estimate" | "settled" | "corrected" | undefined;
    source?: "lookup" | "estimate" | "inline" | "settlement" | undefined;
    externalId: string;
    revision: number;
    nanos: number;
    totalNanos: number;
}> & Pick<{
    _id: import("convex/values").GenericId<"deliveries">;
    _creationTime: number;
    claim?: string | undefined;
    failed: boolean;
    event: {
        status?: "unknown" | "estimate" | "settled" | "corrected" | undefined;
        source?: "lookup" | "estimate" | "inline" | "settlement" | undefined;
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
        runId?: string | undefined;
        threadId?: string | undefined;
        model?: string | undefined;
        rootThreadId?: string | undefined;
        purpose?: "agent" | "title" | "summary" | "tool" | "hook" | undefined;
        nodeId?: string | undefined;
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
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    ok: boolean;
    sink: string;
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
        jobs: {
            deliver?: string | undefined;
            lookup?: string | undefined;
            maxAttempts: number;
        };
        sink: string;
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
/** Host run-close/backstop entry: discovery is idempotent on the pending index. */
export declare const reconcile: import("convex/server").RegisteredMutation<"public", {
    runId: string;
    subject: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    providers: {
        name: string;
        lookupMs: number;
    }[];
}, Promise<null>>;
/** Bounded successor of an explicit sweep; never a perpetual scheduled chain. */
export declare const reconcileRun: import("convex/server").RegisteredMutation<"internal", {
    runId: string;
    subject: string;
    jobs: {
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    };
    providers: {
        name: string;
        lookupMs: number;
    }[];
}, Promise<null>>;
