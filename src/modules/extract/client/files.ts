/**
 * Extraction admission, artifact lookup, and URL acquisition.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { storeFile } from "@convex-dev/agent";
import { createFunctionHandle } from "convex/server";
import { LIMITS, bounded, utf8 } from "../shared/limits.js";
import { authorize, identity, raw, record, view } from "./access.js";
import { ExtractError } from "./backends.js";
import {
  kindOf,
  subjectOf,
  type ArtifactArgs,
  type Completion,
  type FileArgs,
  type RuntimeContext,
  type Scoped,
} from "./context.js";
import { cleanUsage, document } from "./payload.js";
import type { ActionCtx } from "./types.js";
/** Authorize and admit one identity; only an admitted claim can dispatch paid extraction. */
export async function run(
  runtime: RuntimeContext,
  ctx: ActionCtx,
  args: FileArgs & { onComplete?: Completion },
) {
  await authorize(runtime, ctx, {
    operation: "run",
    threadId: args.threadId,
    fileId: args.fileId,
    ...subjectOf(args),
  });

  const { key, file, backend } = await identity(runtime, ctx, args);

  if (!backend) {
    // No backend accepts this file: record the terminal failure without any
    // provider call and return normally, so a turn with such an attachment
    // still completes. `read_file` then returns the typed error.
    const artifactId = await ctx.runMutation(runtime.component.artifacts.reject, {
      ...key,
      failure: "UNSUPPORTED_TYPE",
    });

    return { artifactId, action: "reuse" as const };
  }

  // Files above the default runtime's ceiling can only be extracted by the
  // opt-in Node worker; without one the default worker records TOO_LARGE.
  const worker =
    runtime.options.node && file.info.byteSize > LIMITS.maxBytes[kindOf(file.info.mimeType)]
      ? runtime.options.node.execute
      : runtime.options.worker;

  return ctx.runMutation(runtime.component.artifacts.admit, {
    ...key,
    threadId: args.threadId,
    ...subjectOf(args),
    worker: await createFunctionHandle(worker),
    ...(args.onComplete ? { onComplete: await createFunctionHandle(args.onComplete) } : {}),
  });
}

/** Read a bounded artifact view after exact attachment authorization. */
export async function get(runtime: RuntimeContext, ctx: ActionCtx, args: FileArgs | ArtifactArgs) {
  if ("artifactId" in args) return view(await raw(runtime, ctx, args, "get"));

  await authorize(runtime, ctx, {
    operation: "get",
    threadId: args.threadId,
    fileId: args.fileId,
    ...subjectOf(args),
  });

  const { key } = await identity(runtime, ctx, args);
  const row = await ctx.runQuery(runtime.component.artifacts.lookup, key);

  return row ? view(row) : null;
}

/** Authorize URL acquisition and account provider usage before validating or storing output. */
export async function fromUrl(
  runtime: RuntimeContext,
  ctx: ActionCtx,
  args: Scoped & { url: string },
) {
  await authorize(runtime, ctx, {
    operation: "fromUrl",
    threadId: args.threadId,
    ...subjectOf(args),
  });

  bounded(args.url, LIMITS.urlBytes);
  let url: URL;

  try {
    url = new URL(args.url);
  } catch {
    throw new Error("INVALID_EXTRACT_ARGUMENT");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("INVALID_EXTRACT_ARGUMENT");

  const backend = runtime.backends.find((value) => value.fromUrl);

  if (!backend?.fromUrl) throw new ExtractError("UNSUPPORTED_TYPE");

  const result = await backend.fromUrl(
    args.url,
    AbortSignal.timeout(LIMITS.providerMs),
    runtime.payloadCeiling,
  );

  const usage = cleanUsage(result.usage);

  // Account before validation/storage: a failed parse or oversized fetched
  // result still consumed the provider's reported credits.
  await record(runtime, ctx, { threadId: args.threadId, backend: backend.id }, usage);

  if (!result.ok) throw new ExtractError(result.failure);

  const { doc } = document(result.doc, runtime.payloadCeiling);

  if (utf8(doc.text).length > runtime.ceiling("text")) throw new ExtractError("TOO_LARGE");

  const saved = await storeFile(
    ctx,
    runtime.options.agent,
    new Blob([doc.text], { type: "text/markdown" }),
    { filename: "web-page.md" },
  );

  return { fileId: saved.file.fileId, ...(usage ? { usage } : {}) };
}
