/**
 * Bounded host filesystem reads, writes and directory listings.
 * Read tools and the once-tool write body call these helpers with trusted request facts.
 * Paid effects are never replayed here; the core once-tool ledger owns receipts.
 */
import { LIMITS, bounded, integer, tail } from "../shared/limits.js";
import { type SandboxCall } from "./types.js";
import { within, observe, type RuntimeContext } from "./runtime-context.js";
import { prepare } from "./lifecycle.js";

/** Read a bounded tail without copying file content into a receipt or module row. */
export async function readFile(runtime: RuntimeContext, tc: SandboxCall, input: { path: string }) {
  const { limits, provider } = runtime;

  bounded(input.path, LIMITS.pathChars, "PATH");
  const { sandboxId } = await prepare(runtime, tc);

  const content = await within(runtime, tc.ctx, () =>
    provider.readFile(tc.ctx, sandboxId, input.path, {
      maxBytes: limits.fileReadChars * LIMITS.utf8BytesPerChar,
    }),
  );

  tc.signal.throwIfAborted();

  return { content: tail(content, limits.fileReadChars) };
}

/** Write bounded text once; an unacknowledged write stays unknown for receipt reconciliation. */
export async function writeFile(
  runtime: RuntimeContext,
  tc: SandboxCall,
  input: { path: string; content: string },
) {
  const { limits, provider } = runtime;

  bounded(input.path, LIMITS.pathChars, "PATH");

  if (typeof input.content !== "string" || input.content.length > limits.writeChars)
    throw new Error("SANDBOX_WRITE_TOO_LARGE");

  const { sandboxId } = await prepare(runtime, tc);

  tc.signal.throwIfAborted();

  try {
    await within(runtime, tc.ctx, () =>
      provider.writeFile(tc.ctx, sandboxId, input.path, input.content),
    );

    tc.signal.throwIfAborted();
    await observe(runtime, tc.ctx, sandboxId, "write", "observed", tc);

    return { status: "done" as const };
  } catch {
    await observe(runtime, tc.ctx, sandboxId, "write", "unknown", tc);

    return { status: "unknown" as const };
  }
}

/** Return at most the registered entry count, with bounded names and finite sizes. */
export async function list(runtime: RuntimeContext, tc: SandboxCall, input: { path: string }) {
  const { limits, provider } = runtime;

  bounded(input.path, LIMITS.pathChars, "PATH");
  const { sandboxId } = await prepare(runtime, tc);

  const entries = await within(runtime, tc.ctx, () =>
    provider.listFiles(tc.ctx, sandboxId, input.path, { limit: limits.listEntries }),
  );

  tc.signal.throwIfAborted();

  return {
    entries: entries.slice(0, limits.listEntries).map((entry) => ({
      name: bounded(entry.name, LIMITS.pathChars, "FILENAME"),
      isDir: Boolean(entry.isDir),
      ...(entry.size === undefined
        ? {}
        : { size: integer(entry.size, Number.MAX_SAFE_INTEGER, "FILE_SIZE", 0) }),
    })),
  };
}
