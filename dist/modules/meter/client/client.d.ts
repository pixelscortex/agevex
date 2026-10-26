/**
 * Public host meter factory: resolve registration and compose focused builders.
 * The installing app uses this API for scoped recording, aggregate reads,
 * core slots, maintenance and internal worker exports. Component function
 * paths and per-operation authorization remain owned by their respective builders.
 */
import type { ComponentApi } from "../component/_generated/component.js";
import type { Attribution, MeterOptions, WriteCtx } from "./types.js";
export { inline } from "./pricing.js";
/** Validate registration once and bind the standalone API and core adapters to its context. */
export declare function defineMeter(component: ComponentApi, options: MeterOptions): {
    internalFunctions: () => {
        meterLookup: import("convex/server").RegisteredAction<"internal", {
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
        meterDeliver: import("convex/server").RegisteredAction<"internal", {
            claim: string;
            jobs: {
                deliver?: string | undefined;
                lookup?: string | undefined;
                maxAttempts: number;
            };
            sink: string;
        }, Promise<null>>;
    };
    reconcile: (ctx: WriteCtx, args: {
        subject: string;
        runId: string;
    }) => Promise<null>;
    prune: (ctx: WriteCtx, args: {
        before: number;
        limit?: number;
    }) => Promise<{
        deleted: number;
        more: boolean;
    }>;
    retrySinks: (ctx: WriteCtx, args: {
        key: string;
        subject: string;
    }) => Promise<null>;
    usageView: (ctx: import("./types.js").ReadCtx, args: import("../../../client/slots.js").UsageViewArgs) => Promise<{
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
    }>;
    threadCost: (ctx: import("./types.js").ReadCtx, args: {
        threadId: string;
        cursors?: Partial<Record<"agent" | "model" | "provider", string>>;
    }) => Promise<{
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
    }>;
    subjectCost: (ctx: import("./types.js").ReadCtx, args: {
        subject: string;
        runId?: string;
    }) => Promise<{
        blockingUnknown: number;
        totalNanos: number;
        estimatedNanos: number;
        settledNanos: number;
        unknown: number;
        unknownNanos: number;
        usd: {
            estimated: number;
            settled: number;
        };
    }>;
    breakdown: (ctx: import("./types.js").ReadCtx, args: {
        subject: string;
        from: number;
        to: number;
        by: "day" | "agent" | "model" | "provider";
        cursor?: string;
    }) => Promise<{
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
    }>;
    check: (ctx: import("./types.js").ReadCtx, args: {
        subject: string;
        runId?: string;
    }) => Promise<{
        maxNanos: number | null;
        blockingUnknown: number;
        totalNanos: number;
        estimatedNanos: number;
        settledNanos: number;
        unknown: number;
        unknownNanos: number;
        usd: {
            estimated: number;
            settled: number;
        };
        allowed: boolean;
    }>;
    scope: (ctx: WriteCtx, attribution: Attribution) => import("./types.js").ScopedMeter;
    usageSlot: (slot?: {
        providers?: Record<string, string>;
    }) => import("../../../client/slots.js").UsageSlot;
    budgetSlot: (policy?: MeterOptions["budgets"]) => import("../../../client/slots.js").BudgetSlot;
};
export type Meter = ReturnType<typeof defineMeter>;
/** Agent pages are always present; model/provider pages are optional opt-ins. */
export type ThreadCost = Awaited<ReturnType<Meter["threadCost"]>>;
