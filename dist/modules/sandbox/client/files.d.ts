import { type SandboxCall } from "./types.js";
import { type RuntimeContext } from "./runtime-context.js";
/** Read a bounded tail without copying file content into a receipt or module row. */
export declare function readFile(runtime: RuntimeContext, tc: SandboxCall, input: {
    path: string;
}): Promise<{
    content: string;
}>;
/** Write bounded text once; an unacknowledged write stays unknown for receipt reconciliation. */
export declare function writeFile(runtime: RuntimeContext, tc: SandboxCall, input: {
    path: string;
    content: string;
}): Promise<{
    status: "done";
} | {
    status: "unknown";
}>;
/** Return at most the registered entry count, with bounded names and finite sizes. */
export declare function list(runtime: RuntimeContext, tc: SandboxCall, input: {
    path: string;
}): Promise<{
    entries: {
        size?: number | undefined;
        name: string;
        isDir: boolean;
    }[];
}>;
