import { type SandboxContext, type SandboxExportArgs, type SandboxExportResult } from "./types.js";
import { type RuntimeContext } from "./runtime-context.js";
/** Export through native Agent storeFile, with no parallel file registry. */
export declare function exportSandbox(runtime: RuntimeContext, ctx: SandboxContext, input: SandboxExportArgs): Promise<SandboxExportResult>;
