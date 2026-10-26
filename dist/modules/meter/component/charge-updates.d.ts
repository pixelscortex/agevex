/**
 * Amount transitions, authoritative settlement and correction replay.
 * The registered update mutation invokes this handler after wire validation.
 * Each change patches the charge, replaces its existing aggregate projections,
 * prepares sinks, then snapshots the result in the immutable operation ledger.
 */
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import type { UpdateArgs } from "./charge-contracts.js";
import { type Outcome } from "./charge-records.js";
import { type Jobs } from "./jobs.js";
/** Advance only amount/state revisions, updating projections before preparing sink events. */
export declare function change(ctx: MutationCtx, row: Doc<"charges">, patch: Partial<Doc<"charges">>, config: Jobs): Promise<{
    terminal: boolean;
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
    breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
}>;
/** Replay a stable operation or apply the same settlement/correction precedence fences. */
export declare function updateCharge(ctx: MutationCtx, args: UpdateArgs): Promise<Outcome>;
