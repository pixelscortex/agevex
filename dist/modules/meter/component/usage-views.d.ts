/** Bounded reactive usage views for host queries and the optional core slot.
 * One owned run plus <=59 known nodes; no charge or transcript discovery.
 */
import { v, type Infer } from "convex/values";
import type { QueryCtx } from "./_generated/server.js";
export declare const usageViewArgs: {
    subject: import("convex/values").VString<string, "required">;
    runId: import("convex/values").VString<string, "required">;
    nodeIds: import("convex/values").VArray<(string | null)[], import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>, "required">;
    partial: import("convex/values").VBoolean<boolean | undefined, "optional">;
};
export declare const usageView: import("convex/values").VObject<{
    unknown: number;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedUsd: number;
    settledUsd: number;
    reporting: "partial" | "available";
}, {
    inputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    outputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    estimatedUsd: import("convex/values").VFloat64<number, "required">;
    settledUsd: import("convex/values").VFloat64<number, "required">;
    unknown: import("convex/values").VFloat64<number, "required">;
    reporting: import("convex/values").VUnion<"partial" | "available", [import("convex/values").VLiteral<"available", "required">, import("convex/values").VLiteral<"partial", "required">], "required", never>;
}, "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">;
export declare const usageProjection: import("convex/values").VObject<{
    total: {
        unknown: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        reporting: "partial" | "available";
    };
    nodes: {
        usage: {
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        };
        nodeId: string | null;
    }[];
}, {
    total: import("convex/values").VObject<{
        unknown: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        reporting: "partial" | "available";
    }, {
        inputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        outputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        estimatedUsd: import("convex/values").VFloat64<number, "required">;
        settledUsd: import("convex/values").VFloat64<number, "required">;
        unknown: import("convex/values").VFloat64<number, "required">;
        reporting: import("convex/values").VUnion<"partial" | "available", [import("convex/values").VLiteral<"available", "required">, import("convex/values").VLiteral<"partial", "required">], "required", never>;
    }, "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">;
    nodes: import("convex/values").VArray<{
        usage: {
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        };
        nodeId: string | null;
    }[], import("convex/values").VObject<{
        usage: {
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        };
        nodeId: string | null;
    }, {
        nodeId: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        usage: import("convex/values").VObject<{
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        }, {
            inputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
            outputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
            estimatedUsd: import("convex/values").VFloat64<number, "required">;
            settledUsd: import("convex/values").VFloat64<number, "required">;
            unknown: import("convex/values").VFloat64<number, "required">;
            reporting: import("convex/values").VUnion<"partial" | "available", [import("convex/values").VLiteral<"available", "required">, import("convex/values").VLiteral<"partial", "required">], "required", never>;
        }, "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">;
    }, "required", "usage" | "nodeId" | "usage.inputTokens" | "usage.outputTokens" | "usage.unknown" | "usage.estimatedUsd" | "usage.settledUsd" | "usage.reporting">, "required">;
}, "required", "total" | "nodes" | "total.unknown" | "total.inputTokens" | "total.outputTokens" | "total.estimatedUsd" | "total.settledUsd" | "total.reporting">;
/** Complete namespaces read <=7 docs per aggregate operation (lazy root and
 * <=5 children plus metadata). 60*(4 cost + 4 token) <=3360 docs / <7 MiB
 * at <=2 KiB/node; <4096 queries. Output <=60*512 bytes <32 KiB.
 */
export declare function readUsage(ctx: QueryCtx, args: Infer<ReturnType<typeof v.object<typeof usageViewArgs>>>): Promise<{
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
