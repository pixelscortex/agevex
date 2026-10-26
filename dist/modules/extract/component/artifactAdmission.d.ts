import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
type AdmissionArgs = {
    fileId: string;
    backend: string;
    version: string;
    optionsHash: string;
    worker: string;
    threadId: string;
    subject?: string;
    onComplete?: string;
};
type AdmissionResult = {
    artifactId: Id<"artifacts">;
    action: "run" | "wait" | "reuse";
    callback?: "stored" | "dropped";
};
/** Validate before the identity read; pending insertion precedes dispatch in this transaction. */
export declare function admitArtifact(ctx: MutationCtx, args: AdmissionArgs): Promise<AdmissionResult>;
/** Build a terminal unsupported receipt without dispatch, preserving identity and attempt bounds. */
export declare function newRejectedArtifact(args: Pick<AdmissionArgs, "fileId" | "backend" | "version" | "optionsHash"> & {
    failure: NonNullable<Doc<"artifacts">["failure"]>;
}): Omit<Doc<"artifacts">, "_id" | "_creationTime">;
export {};
