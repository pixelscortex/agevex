import { type MeterContext } from "./configuration.js";
import type { ReadCtx } from "./types.js";
import type { UsageViewArgs } from "../../../client/slots.js";
/** Check a budget snapshot after authorization; trusted core calls validate labels only. */
export declare function check(meter: MeterContext, ctx: ReadCtx, args: {
    subject: string;
    runId?: string;
}, budgetPolicy?: ((scope: {
    subject: string;
    runId?: string;
}) => {
    maxUsd: number;
} | Promise<{
    maxUsd: number;
}>) | undefined, trusted?: boolean): Promise<{
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
/** Compose the host read API with the same authorization and opt-in projection checks. */
export declare function costReads(meter: MeterContext): {
    usageView: (ctx: ReadCtx, args: UsageViewArgs) => Promise<{
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
    threadCost: (ctx: ReadCtx, args: {
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
    subjectCost: (ctx: ReadCtx, args: {
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
    breakdown: (ctx: ReadCtx, args: {
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
    check: (ctx: ReadCtx, args: {
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
};
