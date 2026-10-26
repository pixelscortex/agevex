import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { LIMITS, sliceText, utf8 } from "../shared/limits.js";
import { authorize, fileInfo, record } from "./access.js";
import { AUTO_INDEX_KEY } from "./adapter.js";
import { ExtractError } from "./backends.js";
import { kindOf, storageId, subjectOf } from "./context.js";
import { index } from "./indexing.js";
import { cleanUsage, document } from "./payload.js";
/**
 * Hash a stored blob in streamed chunks. `crypto.subtle.digest` needs the
 * whole file as one more ArrayBuffer (N extra bytes); the incremental hasher
 * is constant space, so the checksum adds nothing to the arithmetic in LIMITS.
 */
async function verifiedBlob(ctx, file, max) {
    const blob = await ctx.storage.get(storageId(file.storage));
    if (!blob)
        throw new ExtractError("OBJECT_UNAVAILABLE");
    if (blob.size > max)
        throw new ExtractError("TOO_LARGE");
    const hash = sha256.create();
    const reader = blob.stream().getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        hash.update(value);
    }
    if (bytesToHex(hash.digest()) !== file.info.hash)
        throw new ExtractError("CHECKSUM_FAILED");
    return blob;
}
/** Claim once, publish under the same fence, then account and clean only unreferenced blobs. */
export async function execute(runtime, ctx, args) {
    const fence = { artifactId: args.artifactId, attempt: args.attempt, claim: args.claim };
    if (!(await ctx.runMutation(runtime.component.artifacts.start, fence)))
        return null;
    const state = { committed: false, backendId: "unavailable" };
    try {
        await executeAttempt(runtime, ctx, args, fence, state);
    }
    catch (error) {
        await ctx.runMutation(runtime.component.artifacts.complete, {
            ...fence,
            ...(error instanceof ExtractError ? { failure: error.code } : { unknown: true }),
            ...(state.usage ? { usage: state.usage } : {}),
        });
    }
    finally {
        await finishExecution(runtime, ctx, args, state);
    }
    await automaticIndex(runtime, ctx, args, state);
    return null;
}
/**
 * A host refusal BEFORE the provider is called (file detached, policy
 * unavailable, transient host error) is not an unknown paid outcome: it is a
 * retryable object failure.
 * Mapping it keeps the row `failed` so an explicit admission can try again,
 * instead of stranding it in `unknown`, which is never rerun.
 */
async function authorizeExecution(runtime, ctx, args, id) {
    try {
        await authorize(runtime, ctx, {
            operation: "execute",
            threadId: args.threadId,
            fileId: id,
            ...subjectOf(args),
        });
    }
    catch {
        throw new ExtractError("OBJECT_UNAVAILABLE");
    }
}
/** Load and authorize the exact file before the provider; retain accounting even on later failure. */
async function executeAttempt(runtime, ctx, args, fence, state) {
    const row = await ctx.runQuery(runtime.component.artifacts.get, { artifactId: args.artifactId });
    if (!row)
        throw new ExtractError("OBJECT_UNAVAILABLE");
    state.fileId = row.fileId;
    state.backendId = row.backend;
    await authorizeExecution(runtime, ctx, args, state.fileId);
    const backend = runtime.backends.find((value) => value.id === row.backend && value.version === row.version);
    if (!backend)
        throw new ExtractError("UNSUPPORTED_TYPE");
    const file = await fileInfo(runtime, ctx, state.fileId);
    const max = runtime.ceiling(kindOf(file.info.mimeType));
    if (file.info.byteSize > max)
        throw new ExtractError("TOO_LARGE");
    let cached;
    const bytes = () => (cached ??= verifiedBlob(ctx, file, max));
    const result = await backend.run({
        bytes,
        file: file.info,
        signal: AbortSignal.timeout(LIMITS.providerMs),
        payloadBytes: runtime.payloadCeiling,
    });
    state.usage = cleanUsage(result.usage);
    await publishResult(runtime, ctx, fence, state, result);
}
/** Publish sanitized failure or stored payload; paid success is never discarded by a late auth check. */
async function publishResult(runtime, ctx, fence, state, result) {
    // No authorization re-check here. The check above ran BEFORE any paid
    // work and maps a refusal to a retryable failure. Once the provider has
    // succeeded the result is published even if the message or file was
    // detached meanwhile: discarding it would pay again on the next attach,
    // and publishing leaks nothing because every read (`raw`) re-authorizes
    // against the then-current attachment.
    if (!result.ok) {
        // Validate the closed vocabulary before it crosses the component wire;
        // an untrusted backend's arbitrary message never becomes durable state.
        const codes = new Set([
            "UNSUPPORTED_TYPE",
            "UNREADABLE",
            "EMPTY",
            "INVALID_OUTPUT",
            "TOO_LARGE",
            "PROVIDER_UNAVAILABLE",
            "OBJECT_UNAVAILABLE",
            "CHECKSUM_FAILED",
        ]);
        if (!codes.has(result.failure))
            throw new ExtractError("INVALID_OUTPUT");
        await ctx.runMutation(runtime.component.artifacts.complete, {
            ...fence,
            failure: result.failure,
            ...(state.usage ? { usage: state.usage } : {}),
        });
    }
    else {
        const { doc, blob } = document(result.doc, runtime.payloadCeiling);
        state.payloadStorageId = await ctx.storage.store(blob);
        state.committed = await ctx.runMutation(runtime.component.artifacts.complete, {
            ...fence,
            payloadStorageId: state.payloadStorageId,
            summary: {
                kind: doc.kind,
                textBytes: utf8(doc.text).length,
                pages: doc.pages?.length ?? 0,
                preview: sliceText(doc.text, LIMITS.summaryBytes),
                ...(doc.language ? { language: doc.language } : {}),
            },
            ...(state.usage ? { usage: state.usage } : {}),
        });
    }
}
/** Resolve an uncertain commit by exact row before deleting storage, then invoke the usage hook. */
async function finishExecution(runtime, ctx, args, state) {
    // A failed commit may have an unknown outcome; deleting its blob then
    // would corrupt a successful row. Read the exact row before cleanup.
    if (state.payloadStorageId && !state.committed) {
        const row = await ctx.runQuery(runtime.component.artifacts.get, {
            artifactId: args.artifactId,
        });
        if (row?.payloadStorageId !== state.payloadStorageId)
            await ctx.storage.delete(state.payloadStorageId);
    }
    await record(runtime, ctx, {
        artifactId: args.artifactId,
        fileId: state.fileId,
        threadId: args.threadId,
        backend: state.backendId,
    }, state.usage);
}
/** Best-effort automatic indexing never turns a ready extraction into a failed extraction. */
async function automaticIndex(runtime, ctx, args, state) {
    if (runtime.options.autoIndex && state.committed) {
        // Index into the admitting thread's namespace. A failure leaves the
        // extraction ready and is recorded on the index row; search simply
        // returns nothing until an explicit `index` or a later `run` retries.
        try {
            await index(runtime, ctx, {
                artifactId: args.artifactId,
                threadId: args.threadId,
                ...subjectOf(args),
                namespace: args.threadId,
                key: AUTO_INDEX_KEY,
                automatic: true,
            });
        }
        catch {
            // Intentionally ignored: see above.
        }
    }
}
