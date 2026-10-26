/**
 * Charge-to-sink outbox preparation inside charge lifecycle transactions.
 * Pending event snapshots stay immutable until acknowledged, including when
 * a delivery outcome is uncertain. Each pending charge/sink pair has exactly
 * one small deliveries row; Workpool jobs read those rows instead of charges.
 */
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { type Jobs } from "./jobs.js";
/** Outbox snapshots are immutable until acknowledged, including on uncertain
 * delivery. A pending event exists on the charge exactly while its outbox row
 * exists; the row is the copy delivery jobs read. */
export declare function prepareSinks(ctx: MutationCtx, row: Doc<"charges">, config: Jobs, changed?: boolean): Promise<{
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
