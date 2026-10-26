import { type ArtifactArgs, type RuntimeContext } from "./context.js";
import type { ActionCtx } from "./types.js";
/**
 * Index a ready artifact's text into `namespace`. `automatic: true` (the
 * slot and the worker) only creates a missing record: it never re-runs a
 * failed, unknown, released or key-changed index, because that repeats paid
 * embedding; only an explicit call (without it) recovers those.
 */
export declare function index(runtime: RuntimeContext, ctx: ActionCtx, args: ArtifactArgs & {
    namespace: string;
    key: string;
    automatic?: boolean;
}): Promise<{
    entryId: string | undefined;
    status: "pending" | "ready" | "skipped";
    created: boolean;
    replacedEntry: null;
    usage: {
        tokens: number;
    };
}>;
