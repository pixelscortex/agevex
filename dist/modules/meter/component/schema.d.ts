export declare const attribution: import("convex/values").VObject<{
    agent?: string | undefined;
    runId?: string | undefined;
    threadId?: string | undefined;
    model?: string | undefined;
    rootThreadId?: string | undefined;
    purpose?: "agent" | "title" | "summary" | "tool" | "hook" | undefined;
    nodeId?: string | undefined;
    subject: string;
}, {
    subject: import("convex/values").VString<string, "required">;
    rootThreadId: import("convex/values").VString<string | undefined, "optional">;
    threadId: import("convex/values").VString<string | undefined, "optional">;
    runId: import("convex/values").VString<string | undefined, "optional">;
    agent: import("convex/values").VString<string | undefined, "optional">;
    model: import("convex/values").VString<string | undefined, "optional">;
    purpose: import("convex/values").VUnion<"agent" | "title" | "summary" | "tool" | "hook" | undefined, [import("convex/values").VLiteral<"agent", "required">, import("convex/values").VLiteral<"hook", "required">, import("convex/values").VLiteral<"tool", "required">, import("convex/values").VLiteral<"title", "required">, import("convex/values").VLiteral<"summary", "required">], "optional", never>;
    nodeId: import("convex/values").VString<string | undefined, "optional">;
}, "required", "agent" | "runId" | "threadId" | "subject" | "model" | "rootThreadId" | "purpose" | "nodeId">;
export declare const tokens: import("convex/values").VObject<{
    inputTokens: number;
    outputTokens: number;
}, {
    inputTokens: import("convex/values").VFloat64<number, "required">;
    outputTokens: import("convex/values").VFloat64<number, "required">;
}, "required", "inputTokens" | "outputTokens">;
export declare const reconciliation: import("convex/values").VUnion<"running" | "pending" | "complete" | "unavailable" | "exhausted", [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"complete", "required">, import("convex/values").VLiteral<"unavailable", "required">, import("convex/values").VLiteral<"exhausted", "required">], "required", never>;
export declare const status: import("convex/values").VUnion<"unknown" | "estimate" | "settled" | "corrected", [import("convex/values").VLiteral<"estimate", "required">, import("convex/values").VLiteral<"settled", "required">, import("convex/values").VLiteral<"corrected", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
export declare const source: import("convex/values").VUnion<"lookup" | "estimate" | "inline" | "settlement", [import("convex/values").VLiteral<"estimate", "required">, import("convex/values").VLiteral<"inline", "required">, import("convex/values").VLiteral<"settlement", "required">, import("convex/values").VLiteral<"lookup", "required">], "required", never>;
export declare const breakdowns: import("convex/values").VArray<("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[], import("convex/values").VUnion<"thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider", [import("convex/values").VLiteral<"thread.model", "required">, import("convex/values").VLiteral<"thread.provider", "required">, import("convex/values").VLiteral<"subject.agent", "required">, import("convex/values").VLiteral<"subject.model", "required">, import("convex/values").VLiteral<"subject.provider", "required">], "required", never>, "required">;
export declare const event: import("convex/values").VObject<{
    externalId: string;
    revision: number;
    nanos: number;
    totalNanos: number;
}, {
    externalId: import("convex/values").VString<string, "required">;
    revision: import("convex/values").VFloat64<number, "required">;
    nanos: import("convex/values").VFloat64<number, "required">;
    totalNanos: import("convex/values").VFloat64<number, "required">;
}, "required", "externalId" | "revision" | "nanos" | "totalNanos">;
/** Why a charge was created `unknown`. Set once at creation, kept after a later settlement. */
export declare const reason: import("convex/values").VUnion<"NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY", [import("convex/values").VLiteral<"NO_COST", "required">, import("convex/values").VLiteral<"DECODE_FAILED", "required">, import("convex/values").VLiteral<"INVALID_COST", "required">, import("convex/values").VLiteral<"OVER_CAP", "required">, import("convex/values").VLiteral<"PROVIDER_NOT_REGISTERED", "required">, import("convex/values").VLiteral<"PROFILE_NOT_REGISTERED", "required">, import("convex/values").VLiteral<"THREAD_CAPACITY", "required">], "required", never>;
/** Stored on the charge: only what changes with the charge's own amount. */
export declare const sinkState: import("convex/values").VArray<{
    pending?: {
        externalId: string;
        revision: number;
        nanos: number;
        totalNanos: number;
    } | undefined;
    deliveredNanos?: number | undefined;
    name: string;
    revision: number;
}[], import("convex/values").VObject<{
    pending?: {
        externalId: string;
        revision: number;
        nanos: number;
        totalNanos: number;
    } | undefined;
    deliveredNanos?: number | undefined;
    name: string;
    revision: number;
}, {
    name: import("convex/values").VString<string, "required">;
    deliveredNanos: import("convex/values").VFloat64<number | undefined, "optional">;
    revision: import("convex/values").VFloat64<number, "required">;
    pending: import("convex/values").VObject<{
        externalId: string;
        revision: number;
        nanos: number;
        totalNanos: number;
    } | undefined, {
        externalId: import("convex/values").VString<string, "required">;
        revision: import("convex/values").VFloat64<number, "required">;
        nanos: import("convex/values").VFloat64<number, "required">;
        totalNanos: import("convex/values").VFloat64<number, "required">;
    }, "optional", "externalId" | "revision" | "nanos" | "totalNanos">;
}, "required", "name" | "pending" | "revision" | "deliveredNanos" | "pending.externalId" | "pending.revision" | "pending.nanos" | "pending.totalNanos">, "required">;
/** Returned to callers: retry state joined from the charge's <=4 `deliveries` rows. */
export declare const sinkView: import("convex/values").VArray<{
    pending?: {
        externalId: string;
        revision: number;
        nanos: number;
        totalNanos: number;
    } | undefined;
    deliveredNanos?: number | undefined;
    name: string;
    failed: boolean;
    attempts: number;
    revision: number;
}[], import("convex/values").VObject<{
    pending?: {
        externalId: string;
        revision: number;
        nanos: number;
        totalNanos: number;
    } | undefined;
    deliveredNanos?: number | undefined;
    name: string;
    failed: boolean;
    attempts: number;
    revision: number;
}, {
    attempts: import("convex/values").VFloat64<number, "required">;
    failed: import("convex/values").VBoolean<boolean, "required">;
    name: import("convex/values").VString<string, "required">;
    deliveredNanos: import("convex/values").VFloat64<number | undefined, "optional">;
    revision: import("convex/values").VFloat64<number, "required">;
    pending: import("convex/values").VObject<{
        externalId: string;
        revision: number;
        nanos: number;
        totalNanos: number;
    } | undefined, {
        externalId: import("convex/values").VString<string, "required">;
        revision: import("convex/values").VFloat64<number, "required">;
        nanos: import("convex/values").VFloat64<number, "required">;
        totalNanos: import("convex/values").VFloat64<number, "required">;
    }, "optional", "externalId" | "revision" | "nanos" | "totalNanos">;
}, "required", "name" | "failed" | "pending" | "attempts" | "revision" | "deliveredNanos" | "pending.externalId" | "pending.revision" | "pending.nanos" | "pending.totalNanos">, "required">;
declare const _default: import("convex/server").SchemaDefinition<{
    charges: import("convex/server").TableDefinition<import("convex/values").VObject<{
        reason?: "NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined;
        credits?: number | undefined;
        nanos?: number | undefined;
        profile?: string | undefined;
        quantity?: number | undefined;
        providerRequestId?: string | undefined;
        tokens?: {
            inputTokens: number;
            outputTokens: number;
        } | undefined;
        reconciliation?: "running" | "pending" | "complete" | "unavailable" | "exhausted" | undefined;
        lookupUntil?: number | undefined;
        lastStale?: {
            operation: string;
            revision: number;
        } | undefined;
        lookupAttempt?: number | undefined;
        status: "unknown" | "estimate" | "settled" | "corrected";
        key: string;
        provider: string;
        source: "lookup" | "estimate" | "inline" | "settlement";
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
        operations: {
            key: string;
            outcome: {
                reason?: "NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined;
                credits?: number | undefined;
                nanos?: number | undefined;
                profile?: string | undefined;
                quantity?: number | undefined;
                providerRequestId?: string | undefined;
                tokens?: {
                    inputTokens: number;
                    outputTokens: number;
                } | undefined;
                reconciliation?: "running" | "pending" | "complete" | "unavailable" | "exhausted" | undefined;
                lookupUntil?: number | undefined;
                lastStale?: {
                    operation: string;
                    revision: number;
                } | undefined;
                lookupAttempt?: number | undefined;
                _id: import("convex/values").GenericId<"charges">;
                _creationTime: number;
                status: "unknown" | "estimate" | "settled" | "corrected";
                key: string;
                provider: string;
                source: "lookup" | "estimate" | "inline" | "settlement";
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
                revision: number;
                sinkState: {
                    pending?: {
                        externalId: string;
                        revision: number;
                        nanos: number;
                        totalNanos: number;
                    } | undefined;
                    deliveredNanos?: number | undefined;
                    name: string;
                    failed: boolean;
                    attempts: number;
                    revision: number;
                }[];
                breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
            };
        }[];
        revision: number;
        sinkState: {
            pending?: {
                externalId: string;
                revision: number;
                nanos: number;
                totalNanos: number;
            } | undefined;
            deliveredNanos?: number | undefined;
            name: string;
            revision: number;
        }[];
        terminal: boolean;
        breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
    }, {
        sinkState: import("convex/values").VArray<{
            pending?: {
                externalId: string;
                revision: number;
                nanos: number;
                totalNanos: number;
            } | undefined;
            deliveredNanos?: number | undefined;
            name: string;
            revision: number;
        }[], import("convex/values").VObject<{
            pending?: {
                externalId: string;
                revision: number;
                nanos: number;
                totalNanos: number;
            } | undefined;
            deliveredNanos?: number | undefined;
            name: string;
            revision: number;
        }, {
            name: import("convex/values").VString<string, "required">;
            deliveredNanos: import("convex/values").VFloat64<number | undefined, "optional">;
            revision: import("convex/values").VFloat64<number, "required">;
            pending: import("convex/values").VObject<{
                externalId: string;
                revision: number;
                nanos: number;
                totalNanos: number;
            } | undefined, {
                externalId: import("convex/values").VString<string, "required">;
                revision: import("convex/values").VFloat64<number, "required">;
                nanos: import("convex/values").VFloat64<number, "required">;
                totalNanos: import("convex/values").VFloat64<number, "required">;
            }, "optional", "externalId" | "revision" | "nanos" | "totalNanos">;
        }, "required", "name" | "pending" | "revision" | "deliveredNanos" | "pending.externalId" | "pending.revision" | "pending.nanos" | "pending.totalNanos">, "required">;
        terminal: import("convex/values").VBoolean<boolean, "required">;
        operations: import("convex/values").VArray<{
            key: string;
            outcome: {
                reason?: "NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined;
                credits?: number | undefined;
                nanos?: number | undefined;
                profile?: string | undefined;
                quantity?: number | undefined;
                providerRequestId?: string | undefined;
                tokens?: {
                    inputTokens: number;
                    outputTokens: number;
                } | undefined;
                reconciliation?: "running" | "pending" | "complete" | "unavailable" | "exhausted" | undefined;
                lookupUntil?: number | undefined;
                lastStale?: {
                    operation: string;
                    revision: number;
                } | undefined;
                lookupAttempt?: number | undefined;
                _id: import("convex/values").GenericId<"charges">;
                _creationTime: number;
                status: "unknown" | "estimate" | "settled" | "corrected";
                key: string;
                provider: string;
                source: "lookup" | "estimate" | "inline" | "settlement";
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
                revision: number;
                sinkState: {
                    pending?: {
                        externalId: string;
                        revision: number;
                        nanos: number;
                        totalNanos: number;
                    } | undefined;
                    deliveredNanos?: number | undefined;
                    name: string;
                    failed: boolean;
                    attempts: number;
                    revision: number;
                }[];
                breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
            };
        }[], import("convex/values").VObject<{
            key: string;
            outcome: {
                reason?: "NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined;
                credits?: number | undefined;
                nanos?: number | undefined;
                profile?: string | undefined;
                quantity?: number | undefined;
                providerRequestId?: string | undefined;
                tokens?: {
                    inputTokens: number;
                    outputTokens: number;
                } | undefined;
                reconciliation?: "running" | "pending" | "complete" | "unavailable" | "exhausted" | undefined;
                lookupUntil?: number | undefined;
                lastStale?: {
                    operation: string;
                    revision: number;
                } | undefined;
                lookupAttempt?: number | undefined;
                _id: import("convex/values").GenericId<"charges">;
                _creationTime: number;
                status: "unknown" | "estimate" | "settled" | "corrected";
                key: string;
                provider: string;
                source: "lookup" | "estimate" | "inline" | "settlement";
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
                revision: number;
                sinkState: {
                    pending?: {
                        externalId: string;
                        revision: number;
                        nanos: number;
                        totalNanos: number;
                    } | undefined;
                    deliveredNanos?: number | undefined;
                    name: string;
                    failed: boolean;
                    attempts: number;
                    revision: number;
                }[];
                breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
            };
        }, {
            key: import("convex/values").VString<string, "required">;
            outcome: import("convex/values").VObject<{
                reason?: "NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined;
                credits?: number | undefined;
                nanos?: number | undefined;
                profile?: string | undefined;
                quantity?: number | undefined;
                providerRequestId?: string | undefined;
                tokens?: {
                    inputTokens: number;
                    outputTokens: number;
                } | undefined;
                reconciliation?: "running" | "pending" | "complete" | "unavailable" | "exhausted" | undefined;
                lookupUntil?: number | undefined;
                lastStale?: {
                    operation: string;
                    revision: number;
                } | undefined;
                lookupAttempt?: number | undefined;
                _id: import("convex/values").GenericId<"charges">;
                _creationTime: number;
                status: "unknown" | "estimate" | "settled" | "corrected";
                key: string;
                provider: string;
                source: "lookup" | "estimate" | "inline" | "settlement";
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
                revision: number;
                sinkState: {
                    pending?: {
                        externalId: string;
                        revision: number;
                        nanos: number;
                        totalNanos: number;
                    } | undefined;
                    deliveredNanos?: number | undefined;
                    name: string;
                    failed: boolean;
                    attempts: number;
                    revision: number;
                }[];
                breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
            }, {
                sinkState: import("convex/values").VArray<{
                    pending?: {
                        externalId: string;
                        revision: number;
                        nanos: number;
                        totalNanos: number;
                    } | undefined;
                    deliveredNanos?: number | undefined;
                    name: string;
                    failed: boolean;
                    attempts: number;
                    revision: number;
                }[], import("convex/values").VObject<{
                    pending?: {
                        externalId: string;
                        revision: number;
                        nanos: number;
                        totalNanos: number;
                    } | undefined;
                    deliveredNanos?: number | undefined;
                    name: string;
                    failed: boolean;
                    attempts: number;
                    revision: number;
                }, {
                    attempts: import("convex/values").VFloat64<number, "required">;
                    failed: import("convex/values").VBoolean<boolean, "required">;
                    name: import("convex/values").VString<string, "required">;
                    deliveredNanos: import("convex/values").VFloat64<number | undefined, "optional">;
                    revision: import("convex/values").VFloat64<number, "required">;
                    pending: import("convex/values").VObject<{
                        externalId: string;
                        revision: number;
                        nanos: number;
                        totalNanos: number;
                    } | undefined, {
                        externalId: import("convex/values").VString<string, "required">;
                        revision: import("convex/values").VFloat64<number, "required">;
                        nanos: import("convex/values").VFloat64<number, "required">;
                        totalNanos: import("convex/values").VFloat64<number, "required">;
                    }, "optional", "externalId" | "revision" | "nanos" | "totalNanos">;
                }, "required", "name" | "failed" | "pending" | "attempts" | "revision" | "deliveredNanos" | "pending.externalId" | "pending.revision" | "pending.nanos" | "pending.totalNanos">, "required">;
                _id: import("convex/values").VId<import("convex/values").GenericId<"charges">, "required">;
                _creationTime: import("convex/values").VFloat64<number, "required">;
                key: import("convex/values").VString<string, "required">;
                attribution: import("convex/values").VObject<{
                    agent?: string | undefined;
                    runId?: string | undefined;
                    threadId?: string | undefined;
                    model?: string | undefined;
                    rootThreadId?: string | undefined;
                    purpose?: "agent" | "title" | "summary" | "tool" | "hook" | undefined;
                    nodeId?: string | undefined;
                    subject: string;
                }, {
                    subject: import("convex/values").VString<string, "required">;
                    rootThreadId: import("convex/values").VString<string | undefined, "optional">;
                    threadId: import("convex/values").VString<string | undefined, "optional">;
                    runId: import("convex/values").VString<string | undefined, "optional">;
                    agent: import("convex/values").VString<string | undefined, "optional">;
                    model: import("convex/values").VString<string | undefined, "optional">;
                    purpose: import("convex/values").VUnion<"agent" | "title" | "summary" | "tool" | "hook" | undefined, [import("convex/values").VLiteral<"agent", "required">, import("convex/values").VLiteral<"hook", "required">, import("convex/values").VLiteral<"tool", "required">, import("convex/values").VLiteral<"title", "required">, import("convex/values").VLiteral<"summary", "required">], "optional", never>;
                    nodeId: import("convex/values").VString<string | undefined, "optional">;
                }, "required", "agent" | "runId" | "threadId" | "subject" | "model" | "rootThreadId" | "purpose" | "nodeId">;
                provider: import("convex/values").VString<string, "required">;
                breakdowns: import("convex/values").VArray<("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[], import("convex/values").VUnion<"thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider", [import("convex/values").VLiteral<"thread.model", "required">, import("convex/values").VLiteral<"thread.provider", "required">, import("convex/values").VLiteral<"subject.agent", "required">, import("convex/values").VLiteral<"subject.model", "required">, import("convex/values").VLiteral<"subject.provider", "required">], "required", never>, "required">;
                profile: import("convex/values").VString<string | undefined, "optional">;
                quantity: import("convex/values").VFloat64<number | undefined, "optional">;
                status: import("convex/values").VUnion<"unknown" | "estimate" | "settled" | "corrected", [import("convex/values").VLiteral<"estimate", "required">, import("convex/values").VLiteral<"settled", "required">, import("convex/values").VLiteral<"corrected", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
                source: import("convex/values").VUnion<"lookup" | "estimate" | "inline" | "settlement", [import("convex/values").VLiteral<"estimate", "required">, import("convex/values").VLiteral<"inline", "required">, import("convex/values").VLiteral<"settlement", "required">, import("convex/values").VLiteral<"lookup", "required">], "required", never>;
                nanos: import("convex/values").VFloat64<number | undefined, "optional">;
                credits: import("convex/values").VFloat64<number | undefined, "optional">;
                providerRequestId: import("convex/values").VString<string | undefined, "optional">;
                tokens: import("convex/values").VObject<{
                    inputTokens: number;
                    outputTokens: number;
                } | undefined, {
                    inputTokens: import("convex/values").VFloat64<number, "required">;
                    outputTokens: import("convex/values").VFloat64<number, "required">;
                }, "optional", "inputTokens" | "outputTokens">;
                reconciliation: import("convex/values").VUnion<"running" | "pending" | "complete" | "unavailable" | "exhausted" | undefined, [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"complete", "required">, import("convex/values").VLiteral<"unavailable", "required">, import("convex/values").VLiteral<"exhausted", "required">], "optional", never>;
                lookupUntil: import("convex/values").VFloat64<number | undefined, "optional">;
                revision: import("convex/values").VFloat64<number, "required">;
                lastStale: import("convex/values").VObject<{
                    operation: string;
                    revision: number;
                } | undefined, {
                    operation: import("convex/values").VString<string, "required">;
                    revision: import("convex/values").VFloat64<number, "required">;
                }, "optional", "operation" | "revision">;
                lookupAttempt: import("convex/values").VFloat64<number | undefined, "optional">;
                reason: import("convex/values").VUnion<"NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined, [import("convex/values").VLiteral<"NO_COST", "required">, import("convex/values").VLiteral<"DECODE_FAILED", "required">, import("convex/values").VLiteral<"INVALID_COST", "required">, import("convex/values").VLiteral<"OVER_CAP", "required">, import("convex/values").VLiteral<"PROVIDER_NOT_REGISTERED", "required">, import("convex/values").VLiteral<"PROFILE_NOT_REGISTERED", "required">, import("convex/values").VLiteral<"THREAD_CAPACITY", "required">], "optional", never>;
            }, "required", "_id" | "_creationTime" | "status" | "key" | "reason" | "provider" | "source" | "attribution" | "credits" | "revision" | "nanos" | "sinkState" | "breakdowns" | "profile" | "quantity" | "providerRequestId" | "tokens" | "reconciliation" | "lookupUntil" | "lastStale" | "lookupAttempt" | "attribution.agent" | "attribution.runId" | "attribution.threadId" | "attribution.subject" | "attribution.model" | "attribution.rootThreadId" | "attribution.purpose" | "attribution.nodeId" | "tokens.inputTokens" | "tokens.outputTokens" | "lastStale.operation" | "lastStale.revision">;
        }, "required", "key" | "outcome" | "outcome._id" | "outcome._creationTime" | "outcome.status" | "outcome.key" | "outcome.reason" | "outcome.provider" | "outcome.source" | "outcome.attribution" | "outcome.credits" | "outcome.revision" | "outcome.nanos" | "outcome.sinkState" | "outcome.breakdowns" | "outcome.profile" | "outcome.quantity" | "outcome.providerRequestId" | "outcome.tokens" | "outcome.reconciliation" | "outcome.lookupUntil" | "outcome.lastStale" | "outcome.lookupAttempt" | "outcome.attribution.agent" | "outcome.attribution.runId" | "outcome.attribution.threadId" | "outcome.attribution.subject" | "outcome.attribution.model" | "outcome.attribution.rootThreadId" | "outcome.attribution.purpose" | "outcome.attribution.nodeId" | "outcome.tokens.inputTokens" | "outcome.tokens.outputTokens" | "outcome.lastStale.operation" | "outcome.lastStale.revision">, "required">;
        key: import("convex/values").VString<string, "required">;
        attribution: import("convex/values").VObject<{
            agent?: string | undefined;
            runId?: string | undefined;
            threadId?: string | undefined;
            model?: string | undefined;
            rootThreadId?: string | undefined;
            purpose?: "agent" | "title" | "summary" | "tool" | "hook" | undefined;
            nodeId?: string | undefined;
            subject: string;
        }, {
            subject: import("convex/values").VString<string, "required">;
            rootThreadId: import("convex/values").VString<string | undefined, "optional">;
            threadId: import("convex/values").VString<string | undefined, "optional">;
            runId: import("convex/values").VString<string | undefined, "optional">;
            agent: import("convex/values").VString<string | undefined, "optional">;
            model: import("convex/values").VString<string | undefined, "optional">;
            purpose: import("convex/values").VUnion<"agent" | "title" | "summary" | "tool" | "hook" | undefined, [import("convex/values").VLiteral<"agent", "required">, import("convex/values").VLiteral<"hook", "required">, import("convex/values").VLiteral<"tool", "required">, import("convex/values").VLiteral<"title", "required">, import("convex/values").VLiteral<"summary", "required">], "optional", never>;
            nodeId: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "agent" | "runId" | "threadId" | "subject" | "model" | "rootThreadId" | "purpose" | "nodeId">;
        provider: import("convex/values").VString<string, "required">;
        breakdowns: import("convex/values").VArray<("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[], import("convex/values").VUnion<"thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider", [import("convex/values").VLiteral<"thread.model", "required">, import("convex/values").VLiteral<"thread.provider", "required">, import("convex/values").VLiteral<"subject.agent", "required">, import("convex/values").VLiteral<"subject.model", "required">, import("convex/values").VLiteral<"subject.provider", "required">], "required", never>, "required">;
        profile: import("convex/values").VString<string | undefined, "optional">;
        quantity: import("convex/values").VFloat64<number | undefined, "optional">;
        status: import("convex/values").VUnion<"unknown" | "estimate" | "settled" | "corrected", [import("convex/values").VLiteral<"estimate", "required">, import("convex/values").VLiteral<"settled", "required">, import("convex/values").VLiteral<"corrected", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
        source: import("convex/values").VUnion<"lookup" | "estimate" | "inline" | "settlement", [import("convex/values").VLiteral<"estimate", "required">, import("convex/values").VLiteral<"inline", "required">, import("convex/values").VLiteral<"settlement", "required">, import("convex/values").VLiteral<"lookup", "required">], "required", never>;
        nanos: import("convex/values").VFloat64<number | undefined, "optional">;
        credits: import("convex/values").VFloat64<number | undefined, "optional">;
        providerRequestId: import("convex/values").VString<string | undefined, "optional">;
        tokens: import("convex/values").VObject<{
            inputTokens: number;
            outputTokens: number;
        } | undefined, {
            inputTokens: import("convex/values").VFloat64<number, "required">;
            outputTokens: import("convex/values").VFloat64<number, "required">;
        }, "optional", "inputTokens" | "outputTokens">;
        reconciliation: import("convex/values").VUnion<"running" | "pending" | "complete" | "unavailable" | "exhausted" | undefined, [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"complete", "required">, import("convex/values").VLiteral<"unavailable", "required">, import("convex/values").VLiteral<"exhausted", "required">], "optional", never>;
        lookupUntil: import("convex/values").VFloat64<number | undefined, "optional">;
        revision: import("convex/values").VFloat64<number, "required">;
        lastStale: import("convex/values").VObject<{
            operation: string;
            revision: number;
        } | undefined, {
            operation: import("convex/values").VString<string, "required">;
            revision: import("convex/values").VFloat64<number, "required">;
        }, "optional", "operation" | "revision">;
        lookupAttempt: import("convex/values").VFloat64<number | undefined, "optional">;
        reason: import("convex/values").VUnion<"NO_COST" | "DECODE_FAILED" | "INVALID_COST" | "OVER_CAP" | "PROVIDER_NOT_REGISTERED" | "PROFILE_NOT_REGISTERED" | "THREAD_CAPACITY" | undefined, [import("convex/values").VLiteral<"NO_COST", "required">, import("convex/values").VLiteral<"DECODE_FAILED", "required">, import("convex/values").VLiteral<"INVALID_COST", "required">, import("convex/values").VLiteral<"OVER_CAP", "required">, import("convex/values").VLiteral<"PROVIDER_NOT_REGISTERED", "required">, import("convex/values").VLiteral<"PROFILE_NOT_REGISTERED", "required">, import("convex/values").VLiteral<"THREAD_CAPACITY", "required">], "optional", never>;
    }, "required", "status" | "key" | "reason" | "provider" | "source" | "attribution" | "credits" | "operations" | "revision" | "nanos" | "sinkState" | "terminal" | "breakdowns" | "profile" | "quantity" | "providerRequestId" | "tokens" | "reconciliation" | "lookupUntil" | "lastStale" | "lookupAttempt" | "attribution.agent" | "attribution.runId" | "attribution.threadId" | "attribution.subject" | "attribution.model" | "attribution.rootThreadId" | "attribution.purpose" | "attribution.nodeId" | "tokens.inputTokens" | "tokens.outputTokens" | "lastStale.operation" | "lastStale.revision">, {
        by_key: ["key", "_creationTime"];
        by_run_lookup: ["attribution.subject", "attribution.runId", "reconciliation", "_creationTime"];
        by_terminal: ["terminal", "_creationTime"];
    }, {}, {}>;
    /**
     * Sink outbox: one small row per pending (charge, sink) event, present
     * exactly while that sink's `pending` is set on the charge. It carries the
     * event payload so one delivery job reads <=100 rows of <=2 KiB instead of
     * <=100 charges of up to 280 KiB, and it holds retry state so crash and
     * failure accounting never rewrites large charge rows.
     */
    deliveries: import("convex/server").TableDefinition<import("convex/values").VObject<{
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
    }, {
        sink: import("convex/values").VString<string, "required">;
        key: import("convex/values").VString<string, "required">;
        event: import("convex/values").VObject<{
            externalId: string;
            revision: number;
            nanos: number;
            totalNanos: number;
        }, {
            externalId: import("convex/values").VString<string, "required">;
            revision: import("convex/values").VFloat64<number, "required">;
            nanos: import("convex/values").VFloat64<number, "required">;
            totalNanos: import("convex/values").VFloat64<number, "required">;
        }, "required", "externalId" | "revision" | "nanos" | "totalNanos">;
        attribution: import("convex/values").VObject<{
            agent?: string | undefined;
            runId?: string | undefined;
            threadId?: string | undefined;
            model?: string | undefined;
            rootThreadId?: string | undefined;
            purpose?: "agent" | "title" | "summary" | "tool" | "hook" | undefined;
            nodeId?: string | undefined;
            subject: string;
        }, {
            subject: import("convex/values").VString<string, "required">;
            rootThreadId: import("convex/values").VString<string | undefined, "optional">;
            threadId: import("convex/values").VString<string | undefined, "optional">;
            runId: import("convex/values").VString<string | undefined, "optional">;
            agent: import("convex/values").VString<string | undefined, "optional">;
            model: import("convex/values").VString<string | undefined, "optional">;
            purpose: import("convex/values").VUnion<"agent" | "title" | "summary" | "tool" | "hook" | undefined, [import("convex/values").VLiteral<"agent", "required">, import("convex/values").VLiteral<"hook", "required">, import("convex/values").VLiteral<"tool", "required">, import("convex/values").VLiteral<"title", "required">, import("convex/values").VLiteral<"summary", "required">], "optional", never>;
            nodeId: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "agent" | "runId" | "threadId" | "subject" | "model" | "rootThreadId" | "purpose" | "nodeId">;
        provider: import("convex/values").VString<string, "required">;
        attempts: import("convex/values").VFloat64<number, "required">;
        limited: import("convex/values").VBoolean<boolean, "required">;
        failed: import("convex/values").VBoolean<boolean, "required">;
        dueAt: import("convex/values").VFloat64<number, "required">;
        claim: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "failed" | "event" | "attempts" | "key" | "claim" | "provider" | "attribution" | "attribution.agent" | "attribution.runId" | "attribution.threadId" | "attribution.subject" | "attribution.model" | "attribution.rootThreadId" | "attribution.purpose" | "attribution.nodeId" | "sink" | "limited" | "dueAt" | "event.externalId" | "event.revision" | "event.nanos" | "event.totalNanos">, {
        by_key: ["key", "sink", "_creationTime"];
        by_due: ["sink", "failed", "claim", "dueAt", "_creationTime"];
        by_claim: ["claim", "_creationTime"];
    }, {}, {}>;
    /** One marker per delivery job that has claimed its batch; deleted by the
     * job's onComplete. It distinguishes "claimed, then died" from "died before
     * claiming" after all claimed rows were acknowledged and deleted. */
    claims: import("convex/server").TableDefinition<import("convex/values").VObject<{
        claim: string;
    }, {
        claim: import("convex/values").VString<string, "required">;
    }, "required", "claim">, {
        by_claim: ["claim", "_creationTime"];
    }, {}, {}>;
}, true>;
export default _default;
