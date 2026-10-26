/** Existing aggregates, exclusive node attribution, no ledger scan. */
export declare const usage: import("convex/server").RegisteredQuery<"public", {
    partial?: boolean | undefined;
    runId: string;
    subject: string;
    nodeIds: (string | null)[];
}, Promise<{
    total: {
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        unknown: number;
        reporting: "partial" | "available";
    };
    nodes: {
        nodeId: string | null;
        usage: {
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            unknown: number;
            reporting: "partial" | "available";
        };
    }[];
}>>;
/** Summarize a root thread and page its enabled axes under the capped-tree read budget. */
export declare const threadCost: import("convex/server").RegisteredQuery<"public", {
    cursors?: {
        agent?: string | undefined;
        model?: string | undefined;
        provider?: string | undefined;
    } | undefined;
    threadId: string;
    breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
    maxGroups: number;
}, Promise<{
    byProvider?: {
        page: {
            totalNanos: number;
            estimatedNanos: number;
            settledNanos: number;
            unknown: number;
            unknownNanos: number;
            usd: {
                estimated: number;
                settled: number;
            };
            key: string;
        }[];
        cursor: string | null;
    } | undefined;
    byModel?: {
        page: {
            totalNanos: number;
            estimatedNanos: number;
            settledNanos: number;
            unknown: number;
            unknownNanos: number;
            usd: {
                estimated: number;
                settled: number;
            };
            key: string;
        }[];
        cursor: string | null;
    } | undefined;
    byAgent: {
        page: {
            totalNanos: number;
            estimatedNanos: number;
            settledNanos: number;
            unknown: number;
            unknownNanos: number;
            usd: {
                estimated: number;
                settled: number;
            };
            key: string;
        }[];
        cursor: string | null;
    };
    totalNanos: number;
    estimatedNanos: number;
    settledNanos: number;
    unknown: number;
    unknownNanos: number;
    usd: {
        estimated: number;
        settled: number;
    };
}>>;
/** Read a single subject/run aggregate snapshot for host reporting and budget admission. */
export declare const cost: import("convex/server").RegisteredQuery<"public", {
    runId?: string | undefined;
    subject: string;
}, Promise<{
    totalNanos: number;
    estimatedNanos: number;
    settledNanos: number;
    unknown: number;
    unknownNanos: number;
    usd: {
        estimated: number;
        settled: number;
    };
}>>;
/** Page an enabled subject axis or a bounded UTC-day range without reading charge rows. */
export declare const breakdown: import("convex/server").RegisteredQuery<"public", {
    cursor?: string | undefined;
    from: number;
    subject: string;
    breakdowns: ("thread.model" | "thread.provider" | "subject.agent" | "subject.model" | "subject.provider")[];
    maxGroups: number;
    maxDays: number;
    to: number;
    by: "agent" | "model" | "provider" | "day";
}, Promise<{
    page: {
        totalNanos: number;
        estimatedNanos: number;
        settledNanos: number;
        unknown: number;
        unknownNanos: number;
        usd: {
            estimated: number;
            settled: number;
        };
        key: string;
    }[];
    cursor: string | null;
}>>;
