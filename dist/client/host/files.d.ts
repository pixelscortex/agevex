import type { CoordinatorCtx, RunnerCtx, RuntimeContext } from "../registration/context.js";
export type RegisterFileArgs = {
    agent: string;
    fileId: string;
    subject: string;
};
export type FileAttachedArgs = {
    threadId: string;
    fileId: string;
    subject: string;
};
/**
 * Trusted upload-path helper. Call after storing a file on behalf of the
 * authorized subject; never expose it as a public arbitrary-id claim.
 *
 * The native file row must exist and fit `LIMITS.fileMetadataBytes`, so later
 * attachment admission reads stay bounded.
 */
export declare function registerFile(rt: RuntimeContext, ctx: CoordinatorCtx, args: RegisterFileArgs): Promise<void>;
/**
 * Exact attachment policy for a host tool's authorize callback: true only
 * when the thread belongs to `subject` and that file is attached to it.
 */
export declare function fileAttached(rt: RuntimeContext, ctx: Pick<RunnerCtx, "runQuery">, args: FileAttachedArgs): Promise<boolean>;
