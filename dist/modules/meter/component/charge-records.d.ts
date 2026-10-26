/**
 * Bounded charge reads, caller views and immutable operation receipts.
 * Lifecycle handlers use these helpers before changing charge state; delivery
 * joins at most four outbox rows to expose retry state without embedding it
 * in every large charge rewrite. No registered functions live in this file.
 */
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
/** Load one validated immutable key; used before every charge lifecycle operation. */
export declare function find(ctx: Pick<QueryCtx, "db">, key: string): Promise<{
    _id: import("convex/values").GenericId<"charges">;
    _creationTime: number;
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
        threadId?: string | undefined;
        runId?: string | undefined;
        model?: string | undefined;
        rootThreadId?: string | undefined;
        nodeId?: string | undefined;
        purpose?: "agent" | "tool" | "title" | "hook" | "summary" | undefined;
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
                threadId?: string | undefined;
                runId?: string | undefined;
                model?: string | undefined;
                rootThreadId?: string | undefined;
                nodeId?: string | undefined;
                purpose?: "agent" | "tool" | "title" | "hook" | "summary" | undefined;
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
} | null>;
/**
 * Billing is separate from budgeting. A known cost (inline, settlement or
 * lookup) that is `unknown` only because it overflowed its thread or exceeded
 * the per-charge cap is still delivered to sinks: it is unknown for the gate,
 * billed because the amount is known. Estimates are billed once corrected.
 */
export declare function billable(row: Doc<"charges">): boolean;
/** Missing inline evidence can be recovered by lookup too; expiry never restarts itself. */
export declare function resolved(row: Doc<"charges">): boolean;
/** Settled and acknowledged by every sink (vacuously true without sinks).
 * `corrected` is not terminal: a settlement or lookup may still replace it. */
export declare function isTerminal(row: Doc<"charges">): boolean;
/** Record a rejected state transition once without advancing the amount revision. */
export declare function stale(ctx: MutationCtx, row: Doc<"charges">, operation: string, revision: number): Promise<{
    _id: import("convex/values").GenericId<"charges">;
    _creationTime: number;
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
        threadId?: string | undefined;
        runId?: string | undefined;
        model?: string | undefined;
        rootThreadId?: string | undefined;
        nodeId?: string | undefined;
        purpose?: "agent" | "tool" | "title" | "hook" | "summary" | undefined;
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
                threadId?: string | undefined;
                runId?: string | undefined;
                model?: string | undefined;
                rootThreadId?: string | undefined;
                nodeId?: string | undefined;
                purpose?: "agent" | "tool" | "title" | "hook" | "summary" | undefined;
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
}>;
export type Outcome = Omit<Doc<"charges">, "operations" | "terminal" | "sinkState"> & {
    sinkState: (Doc<"charges">["sinkState"][number] & {
        attempts: number;
        failed: boolean;
    })[];
};
/** Caller-facing charge: retry state is joined from the <=4 outbox rows (one
 * bounded index read), so failures never have to rewrite the large charge row. */
export declare function outcome(ctx: Pick<QueryCtx, "db">, row: Doc<"charges">): Promise<Outcome>;
/** Return the immutable operation result, or fail closed before the receipt ledger fills. */
export declare function replay(row: Doc<"charges">, key: string): {
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
        threadId?: string | undefined;
        runId?: string | undefined;
        model?: string | undefined;
        rootThreadId?: string | undefined;
        nodeId?: string | undefined;
        purpose?: "agent" | "tool" | "title" | "hook" | "summary" | undefined;
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
} | undefined;
/** Snapshot the bounded caller view after all writes, then store this operation receipt. */
export declare function remember(ctx: MutationCtx, row: Doc<"charges">, key: string): Promise<Outcome>;
