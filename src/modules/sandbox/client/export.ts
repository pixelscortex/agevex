/**
 * Binary export from an existing sandbox into native Agent file storage.
 * The host API and optional Node action share authorization and bounded download windows.
 * Incremental hashing verifies stored bytes; no parallel file registry is created.
 */
import { storeFile } from "@convex-dev/agent";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { LIMITS, bounded } from "../shared/limits.js";
import {
  type SandboxCall,
  type SandboxContext,
  type SandboxExportArgs,
  type SandboxExportResult,
} from "./types.js";
import {
  remaining,
  within,
  scopeKey,
  authorize,
  observe,
  type RuntimeContext,
} from "./runtime-context.js";
import { prepare } from "./lifecycle.js";

/** Export through native Agent storeFile, with no parallel file registry. */
export async function exportSandbox(
  runtime: RuntimeContext,
  ctx: SandboxContext,
  input: SandboxExportArgs,
): Promise<SandboxExportResult> {
  const { options } = runtime;

  const { trusted, sandboxId } = await resolveExport(runtime, ctx, input);
  const downloaded = await downloadExport(runtime, ctx, input, sandboxId);

  if ("fileId" in downloaded) return downloaded;

  const { chunks, hash, bytes } = downloaded;

  remaining(runtime, ctx);
  const digest = bytesToHex(hash.digest());
  // Agent storeFile (0.7.7 src/vercel/client/files.ts:58-158) dedupes and
  // stores/registers the Blob once. Let it compute its native hex hash:
  // its supplied-sha256 branch compares hex to Convex's base64 metadata.
  // Compare with our incremental digest instead. Count all four possible
  // whole-file allocations honestly: chunks + Blob + Agent's blob.slice()
  // + its hashing ArrayBuffer (files.ts:62). Default: 4 * 8 MiB =32 MiB
  // plus <=512 KiB transport window, leaving ~31 MiB of the 64 MiB runtime.
  // Node: 4 * 64 MiB =256 MiB plus <=512 KiB window, leaving ~255 MiB of
  // 512 MiB. The incremental hasher is constant space; no extra file copy.
  const blob = new Blob(chunks as BlobPart[], { type: "application/octet-stream" });

  chunks.length = 0;

  const stored = await storeFile(ctx, options.agent!, blob, {
    filename: input.path.split("/").pop(),
  });

  if (stored.file.hash !== digest) throw new Error("SANDBOX_EXPORT_HASH_MISMATCH");

  await observe(runtime, ctx, sandboxId, "export", "observed", trusted);

  return {
    fileId: stored.file.fileId,
    storageId: stored.file.storageId,
    bytes,
    sha256: stored.file.hash,
  };
}

/** Authorize trusted thread ownership before resuming an existing filesystem. */
async function resolveExport(
  runtime: RuntimeContext,
  ctx: SandboxContext,
  input: SandboxExportArgs,
) {
  const { options, component } = runtime;

  bounded(input.threadId, LIMITS.identityChars, "THREAD");
  bounded(input.path, LIMITS.pathChars, "PATH");

  if (!options.agent) throw new Error("SANDBOX_AGENT_REQUIRED");

  const principal = await authorize(runtime, ctx, {
    operation: "export",
    threadId: input.threadId,
  });

  if (options.scope === "run" && !options.resolveThread)
    throw new Error("SANDBOX_THREAD_RESOLVER_REQUIRED");

  const trusted = options.resolveThread
    ? await options.resolveThread(ctx, input.threadId)
    : { subject: principal.subject, threadId: input.threadId, runId: input.threadId };

  if (trusted.subject !== principal.subject || trusted.threadId !== input.threadId)
    throw new Error("SANDBOX_FORBIDDEN");

  const key = await scopeKey(runtime, trusted);
  const row = await ctx.runQuery(component.state.get, { scopeKey: key });

  // A deleted scope has no files left to export. prepare() would reserve a
  // fresh sandbox for it, paying for an empty VM and then failing the read.
  if (!row?.sandboxId || row.state === "deleted" || row.state === "deleting")
    throw new Error("SANDBOX_NOT_FOUND");

  const tc: SandboxCall = {
    ...trusted,
    ctx,
    signal: new AbortController().signal,
    toolCallId: "export",
  };

  // Download from the id prepare resolved, not the row read above.
  // existingOnly makes the reservation itself refuse a scope deleted (or
  // freed) after the check above, inside its own transaction.

  const { sandboxId } = await prepare(runtime, tc, { existingOnly: true });

  return { trusted, sandboxId };
}

/** Buffer bounded windows; overflow clears them before delegating to the Node action. */
async function downloadExport(
  runtime: RuntimeContext,
  ctx: SandboxContext,
  input: SandboxExportArgs,
  sandboxId: string,
) {
  const { options, limits, provider, nodeExport } = runtime;
  // Every component transaction holds constant-size metadata. Only this
  // action buffers bytes, in <=512 KiB windows; overflow creates no storage.
  const maximum = nodeExport ? limits.exportBytesNode : limits.exportBytes;
  const hash = sha256.create();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  for (;;) {
    const maxBytes = Math.min(LIMITS.exportChunkBytes, maximum - bytes + 1);
    let chunk: Uint8Array;

    try {
      chunk = await within(runtime, ctx, () =>
        provider.download(ctx, sandboxId, input.path, {
          maxBytes,
          offset: bytes,
          totalSizeLimit: maximum,
        }),
      );

      if (bytes + chunk.byteLength > maximum) throw new Error("SANDBOX_EXPORT_TOO_LARGE");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "SANDBOX_EXPORT_TOO_LARGE") throw error;

      chunks.length = 0;

      if (!nodeExport && options.nodeExport)
        return within(runtime, ctx, () => ctx.runAction(options.nodeExport!, input));

      throw new Error(
        nodeExport
          ? "SANDBOX_EXPORT_TOO_LARGE: exceeds exportBytesNode (64 MiB hard maximum)"
          : "SANDBOX_EXPORT_TOO_LARGE: register sandboxNodeExport() in a use node file via nodeExport",
      );
    }

    if (chunk.byteLength > maxBytes) throw new Error("SANDBOX_EXPORT_WINDOW_TOO_LARGE");

    bytes += chunk.byteLength;
    hash.update(chunk);
    // Keep the provider-owned window; copying here needlessly duplicates it.
    chunks.push(chunk);

    if (chunk.byteLength < maxBytes) break;
  }

  return { chunks, hash, bytes };
}
