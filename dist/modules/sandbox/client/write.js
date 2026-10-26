/**
 * Bounded binary writes from host bytes or native Convex storage.
 * Only windows cross provider boundaries; target files appear after verified atomic commit.
 */
import { ConvexError } from "convex/values";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { LIMITS, bounded, integer } from "../shared/limits.js";
import { SandboxWriteError, isWriteErrorCode } from "../shared/write.js";
import { authorize, facts, scopeKey, within, observe, } from "./runtime-context.js";
import { prepare } from "./lifecycle.js";
/** Accept the same trusted ToolContext as filesystem operations, or facts from a host action. */
export function bindWriteBytes(runtime) {
    return async (context, input) => {
        const tc = "ctx" in context
            ? context
            : {
                ...facts(input),
                ctx: context,
                signal: new AbortController().signal,
                toolCallId: "writeBytes",
            };
        return writeBytes(runtime, tc, input);
    };
}
/** Validate and authorize before loading storage or creating/resuming a paid sandbox. */
async function writeBytes(runtime, tc, input) {
    bounded(input.path, LIMITS.pathChars, "PATH");
    tc.signal.throwIfAborted();
    await authorize(runtime, tc.ctx, {
        operation: "use",
        scopeKey: await scopeKey(runtime, tc),
        ...facts(tc),
    });
    const maximum = runtime.nodeExport || runtime.options.nodeWrite
        ? runtime.limits.exportBytesNode
        : runtime.limits.exportBytes;
    const maxBytes = input.maxBytes === undefined ? maximum : integer(input.maxBytes, maximum, "WRITE_BYTES", 0);
    const source = input.source;
    if (!source || typeof source !== "object" || "bytes" in source === "storageId" in source)
        throw new Error("SANDBOX_INVALID_WRITE_SOURCE");
    // Actions have no db.system reader. Convex's storage metadata API checks one
    // constant-size record BEFORE storage.get can allocate a whole-file Blob.
    const size = "storageId" in source
        ? (await within(runtime, tc.ctx, () => tc.ctx.storage.getMetadata(source.storageId)))?.size
        : source.bytes instanceof Uint8Array
            ? source.bytes.byteLength
            : undefined;
    if (size === undefined)
        throw new Error("SANDBOX_INVALID_WRITE_SOURCE");
    if (size > maxBytes)
        throw new SandboxWriteError("SANDBOX_WRITE_TOO_LARGE");
    if (!runtime.nodeExport && size > runtime.limits.exportBytes) {
        if (!("storageId" in source) || !runtime.options.nodeWrite)
            throw new SandboxWriteError("SANDBOX_WRITE_TOO_LARGE");
        return delegateWrite(runtime, tc, {
            ...facts(tc),
            path: input.path,
            source,
            ...(input.maxBytes === undefined ? {} : { maxBytes }),
        });
    }
    // Snapshot caller-owned bytes so mutation while awaiting provider calls cannot
    // produce a mixed file. At the hard max: <=3*8 MiB (or 3*64 MiB Node)
    // for source + temporary exact view + Blob (24/192 MiB), plus copies of a
    // <=512 KiB window. No second whole-file hash or transport buffer is needed.
    // No binary enters our component rows; transactions remain constant-size.
    const blob = "storageId" in source
        ? await within(runtime, tc.ctx, () => tc.ctx.storage.get(source.storageId))
        : new Blob([new Uint8Array(source.bytes)]);
    if (!blob || blob.size !== size)
        throw new Error("SANDBOX_INVALID_WRITE_SOURCE");
    const hash = sha256.create();
    for (let offset = 0; offset < size; offset += LIMITS.exportChunkBytes)
        hash.update(new Uint8Array(await blob.slice(offset, offset + LIMITS.exportChunkBytes).arrayBuffer()));
    const expected = { bytes: size, sha256: bytesToHex(hash.digest()) };
    const { sandboxId } = await prepare(runtime, tc);
    await stageWrite(runtime, tc, sandboxId, input.path, blob, expected);
    return expected;
}
/** Large storage writes run in the host's Node action; its typed errors are restored here. */
async function delegateWrite(runtime, tc, args) {
    try {
        return await within(runtime, tc.ctx, () => tc.ctx.runAction(runtime.options.nodeWrite, args));
    }
    catch (error) {
        // Convex serializes only ConvexError data across runAction; a plain Error
        // would arrive as an untyped message.
        const code = error instanceof ConvexError ? error.data?.code : undefined;
        throw isWriteErrorCode(code) ? new SandboxWriteError(code) : error;
    }
}
/** Carry a typed write error out of the Node action so the caller can restore its code. */
export function exportWriteError(error) {
    return error instanceof SandboxWriteError ? new ConvexError({ code: error.code }) : error;
}
/**
 * Give this attempt a private stage beside the target. The path hash lets any
 * attempt find only this path's abandoned stages; the random id keeps live
 * writers from touching each other's files.
 */
function stageNames(path) {
    const directory = path.slice(0, path.lastIndexOf("/") + 1);
    const prefix = `.agevex-write-${bytesToHex(sha256(new TextEncoder().encode(path)))}-`;
    const tempPath = `${directory}${prefix}${bytesToHex(randomBytes(8))}.tmp`;
    bounded(tempPath, LIMITS.pathChars, "PATH");
    bounded(`${tempPath}.window`, LIMITS.pathChars, "PATH");
    return { directory, prefix, tempPath };
}
/** Best effort: a missed sweep only leaves a stale sibling for the next write to this path. */
async function reclaimStale(runtime, tc, sandboxId, names) {
    try {
        await within(runtime, tc.ctx, () => runtime.provider.reclaimWrites(tc.ctx, sandboxId, names.directory, names.prefix, LIMITS.writeStaleMs));
    }
    catch {
        /* Cleanup of other attempts' leftovers never decides this write's outcome. */
    }
    tc.signal.throwIfAborted();
}
/** Stage under a fresh name, reclaim only stale leftovers, then commit atomically (last commit wins). */
async function stageWrite(runtime, tc, sandboxId, path, blob, expected) {
    const { provider } = runtime;
    const names = stageNames(path);
    const { tempPath } = names;
    await reclaimStale(runtime, tc, sandboxId, names);
    try {
        // The empty window creates a stage for zero-length files as well.
        for (let offset = 0; offset < blob.size || offset === 0; offset += LIMITS.exportChunkBytes) {
            tc.signal.throwIfAborted();
            const bytes = new Uint8Array(await blob.slice(offset, offset + LIMITS.exportChunkBytes).arrayBuffer());
            await within(runtime, tc.ctx, () => provider.writeWindow(tc.ctx, sandboxId, tempPath, offset, bytes));
        }
        tc.signal.throwIfAborted();
        await within(runtime, tc.ctx, () => provider.commitWrite(tc.ctx, sandboxId, tempPath, path, expected));
        await observe(runtime, tc.ctx, sandboxId, "write", "observed", tc);
    }
    catch (error) {
        // A typed write error is raised before any rename, so the outcome is known
        // (the target is unchanged). Anything else may follow a completed rename
        // whose response was lost: replaying the same source is safe, but the
        // effect is unknown, and error cleanup never removes the target.
        await observe(runtime, tc.ctx, sandboxId, "write", error instanceof SandboxWriteError ? "observed" : "unknown", tc);
        try {
            await within(runtime, tc.ctx, () => provider.discardWrite(tc.ctx, sandboxId, tempPath));
        }
        catch {
            /* Reclaimed once stale by a later write after a killed/deadline-limited action. */
        }
        throw error;
    }
}
