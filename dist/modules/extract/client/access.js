/**
 * Exact-file identity, host authorization, and artifact views.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { getFile } from "@convex-dev/agent";
import { fingerprint } from "../../../client/once.js";
import { bounded } from "../shared/limits.js";
import { ExtractError } from "./backends.js";
import { UNSUPPORTED_BACKEND, retryable, subjectOf, } from "./context.js";
/** Validate scope identifiers before invoking the host policy on every access. */
export async function authorize(runtime, ctx, scope) {
    bounded(scope.threadId);
    if (scope.fileId !== undefined)
        bounded(scope.fileId);
    if (scope.namespace !== undefined)
        bounded(scope.namespace);
    if (scope.subject !== undefined)
        bounded(scope.subject);
    await runtime.options.authorize(ctx, scope);
}
/** Read one exact native file and its storage metadata; map missing objects to a safe failure. */
export async function fileInfo(runtime, ctx, fileId) {
    try {
        // Agent 0.7.7 src/vercel/client/files.ts:157 reads one exact file row;
        // storeFile at :40 owns hash dedupe/refcounts. No transcript scans or file
        // ownership copies are needed; the host verifies its exact attachment.
        const value = await getFile(ctx, runtime.options.agent, fileId);
        const meta = await ctx.runQuery(runtime.options.storageMetadata, {
            storageId: value.file.storageId,
        });
        if (!meta)
            throw new ExtractError("OBJECT_UNAVAILABLE");
        const info = {
            fileId,
            mimeType: value.filePart.mediaType,
            byteSize: meta.size,
            hash: value.file.hash,
            ...(value.file.filename ? { filename: value.file.filename } : {}),
        };
        return { info, storage: value.file.storageId };
    }
    catch {
        throw new ExtractError("OBJECT_UNAVAILABLE");
    }
}
/** Choose the backend and stable extraction identity without changing paid deduplication. */
export async function identity(runtime, ctx, args) {
    bounded(args.fileId);
    if (args.backend !== undefined)
        bounded(args.backend);
    const file = await fileInfo(runtime, ctx, args.fileId);
    const selected = args.backend ?? runtime.options.route?.(file.info);
    const backend = selected
        ? runtime.backends.find((value) => value.id === selected)
        : runtime.backends.find((value) => value.accepts(file.info));
    const supported = !!backend && backend.accepts(file.info);
    // An explicitly requested backend that cannot take the file is a caller
    // error. When nothing accepts the file at all, the identity is a fixed
    // "unsupported" receipt (see `run`) so an attachment never fails a turn.
    if (!supported && args.backend !== undefined)
        throw new ExtractError("UNSUPPORTED_TYPE");
    // An indexing-only lease change must not create another paid extraction
    // identity. Keep the extraction ceilings as the identity's options input.
    const optionsHash = args.optionsHash ??
        (await fingerprint({
            maxBytes: runtime.limits.maxBytes,
            payloadBytes: runtime.limits.payloadBytes,
        }));
    if (!/^[a-f0-9]{64}$/.test(optionsHash))
        throw new Error("INVALID_EXTRACT_ARGUMENT");
    return {
        file,
        backend: supported ? backend : undefined,
        key: {
            fileId: args.fileId,
            backend: supported ? backend.id : UNSUPPORTED_BACKEND,
            version: supported ? backend.version : "1",
            optionsHash,
        },
    };
}
/** Load one exact artifact and reauthorize its current attachment before exposing it. */
export async function raw(runtime, ctx, args, operation = "read", namespace) {
    bounded(args.artifactId);
    const row = await ctx.runQuery(runtime.component.artifacts.get, { artifactId: args.artifactId });
    if (!row)
        throw new ExtractError("OBJECT_UNAVAILABLE");
    await authorize(runtime, ctx, {
        operation,
        threadId: args.threadId,
        fileId: row.fileId,
        ...(namespace === undefined ? {} : { namespace }),
        ...subjectOf(args),
    });
    return row;
}
/** Build the bounded public view without leaking provider bodies or storage details. */
export function view(row) {
    return {
        artifactId: row._id,
        fileId: row.fileId,
        backend: row.backend,
        version: row.version,
        optionsHash: row.optionsHash,
        status: row.status,
        attempt: row.attempt,
        ...(row.summary ? { summary: row.summary } : {}),
        ...(row.failure
            ? { failure: { code: row.failure, retryable: retryable.has(row.failure) } }
            : {}),
        ...(row.usage ? { usage: row.usage } : {}),
    };
}
/** Report sanitized paid usage after execution or acquisition through the optional host hook. */
export async function record(runtime, ctx, args, usage) {
    if (usage && runtime.options.usage)
        await runtime.options.usage.record(ctx, { ...args, usage });
}
