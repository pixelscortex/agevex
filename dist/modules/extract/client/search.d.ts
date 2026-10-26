import { type RuntimeContext, type Scoped } from "./context.js";
import type { ActionCtx } from "./types.js";
/** Search bounded native chunks, then recheck each hit against its current attachment and index. */
export declare function search(runtime: RuntimeContext, ctx: ActionCtx, args: Scoped & {
    namespace: string;
    query: string;
    limit?: number;
}): Promise<{
    text: string;
    references: {
        artifactId: string;
        fileId: string;
    }[];
    usage: import("ai").EmbeddingModelUsage;
}>;
