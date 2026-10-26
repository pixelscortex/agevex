import type { MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import type { Jobs } from "./jobs.js";
import type { AttachArgs, ExpireArgs, LookupResultArgs } from "./charge-contracts.js";
import { type Outcome } from "./charge-records.js";
/** Attach one immutable provider request, then admit lookup and its independent deadline. */
export declare function attachCharge(ctx: MutationCtx, args: AttachArgs): Promise<Outcome>;
/** Shared admission for attach and the run sweep. The stored window is never reset. */
export declare function startLookup(ctx: MutationCtx, row: Doc<"charges">, requestId: string, lookupMs: number, jobs: Jobs): Promise<{
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
}>;
/** Finish unresolved evidence while retaining the last estimate at its recorded one-shot deadline. */
export declare function expireCharge(ctx: MutationCtx, { id }: ExpireArgs): Promise<void>;
/** Retain late evidence but fence duplicate empty callbacks before scheduling another lookup. */
export declare function recordLookupResult(ctx: MutationCtx, args: LookupResultArgs): Promise<null>;
