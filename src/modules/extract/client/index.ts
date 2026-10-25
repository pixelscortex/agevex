// Host-side module API and helpers; this code is imported by the installing app.
import { getFile, storeFile } from "@convex-dev/agent";
import { RAG, type EntryId } from "@convex-dev/rag";
import { embedMany, tool, wrapEmbeddingModel, type ToolSet } from "ai";
import { createFunctionHandle, internalActionGeneric, internalQueryGeneric } from "convex/server";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";
import type { GenericId } from "convex/values";
import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { fingerprint } from "../../../client/once.js";
import type { ComponentApi } from "../component/_generated/component.js";
import type {
  ActionCtx,
  ExtractOptions,
  FileInfo,
  Scope,
  WorkerArgs,
  NodeReadArgs,
  ProviderUsage,
  BackendResult,
} from "./types.js";
import { LIMITS, bounded, integer, resolveLimits, sliceText, utf8 } from "../shared/limits.js";
import { ExtractError, isTextMime } from "./backends.js";
import { cleanUsage, document, readDocument, textWindow } from "./payload.js";
import { AUTO_INDEX_KEY, extractSlot } from "./adapter.js";
import type { ExtractSlot } from "../../../client/slots.js";

export { directText, firecrawlParse, visionOcr, ExtractError } from "./backends.js";
export { LIMITS } from "../shared/limits.js";
export { authorizeAttached } from "./adapter.js";
export type {
  ExtractBackend,
  BackendInput,
  BackendResult,
  FileInfo,
  ExtractedDoc,
  ExtractFailure,
  ProviderUsage,
  Page,
  ExtractOptions,
  Scope,
  WorkerArgs,
  NodeReadArgs,
} from "./types.js";
export type { ComponentApi } from "../component/_generated/component.js";

/**
 * `subject` is the thread owner a caller already knows (the agevex slot's tool
 * context carries it). It is forwarded to the host `authorize` callback so the
 * exact-attachment check can name its subject; background calls (`execute`)
 * have no caller and let the host resolve the owner from the thread instead.
 */
type Scoped = { threadId: string; subject?: string };

/** Forward an optional subject without writing `subject: undefined` into scopes. */
const subjectOf = (args: { subject?: string }) =>
  args.subject === undefined ? {} : { subject: args.subject };

type FileArgs = Scoped & { fileId: string; backend?: string; optionsHash?: string };
type ArtifactArgs = Scoped & { artifactId: string };
type Completion = FunctionReference<"mutation", "internal", { artifactId: string }, null | void>;
const storageId = (id: string) => id as GenericId<"_storage">;
/** Fixed identity backend of files that no configured backend accepts. */
const UNSUPPORTED_BACKEND = "unsupported";
const retryable = new Set(["PROVIDER_UNAVAILABLE", "OBJECT_UNAVAILABLE", "CHECKSUM_FAILED"]);

/** The runtime-specific byte ceiling (see LIMITS) is chosen by input kind. */
const kindOf = (mimeType: string): "document" | "image" | "text" =>
  mimeType.startsWith("image/") ? "image" : isTextMime(mimeType) ? "text" : "document";

/**
 * Standalone host helper. Export internalFunctions().execute as the worker
 * reference supplied here; only the component can create a valid dispatch
 * claim. Public host wrappers call these methods with the owning thread.
 */
export function defineExtract(component: ComponentApi, options: ExtractOptions) {
  return extractRuntime(component, options, false);
}

/**
 * Opt-in Node variant, exported from a host file beginning with "use node"
 * (512 MiB instead of 64 MiB):
 *
 * ```ts
 * "use node";
 * export const { execute, read } = extractNodeExport(components.agevexExtract, extractOptions);
 * ```
 *
 * Register those two references as `options.node` of `defineExtract`. Files
 * above the default byte ceilings are then extracted by `execute`, and
 * payloads above the default read ceiling are windowed by `read`; both repeat
 * authorization. See LIMITS for the memory arithmetic behind each runtime.
 */
export function extractNodeExport(component: ComponentApi, options: ExtractOptions) {
  const runtime = extractRuntime(component, options, true);

  return {
    execute: runtime.internalFunctions().execute,
    read: internalActionGeneric({
      args: {
        kind: v.union(v.literal("text"), v.literal("pages")),
        threadId: v.string(),
        subject: v.optional(v.string()),
        artifactId: v.string(),
        cursor: v.optional(v.number()),
        maxBytes: v.optional(v.number()),
        from: v.optional(v.number()),
        count: v.optional(v.number()),
      },
      handler: (ctx, args) => runtime.nodeRead(ctx, args as NodeReadArgs),
    }),
  };
}

function extractRuntime(component: ComponentApi, options: ExtractOptions, nodeRuntime: boolean) {
  // Registering the Node actions (or being one) lifts the hard maxima of the
  // configurable byte limits; each runtime still enforces only its own ceiling.
  const limits = resolveLimits(options.limits, nodeRuntime || !!options.node);
  const runtimeMax = nodeRuntime ? LIMITS.node : LIMITS;

  const ceiling = (kind: "document" | "image" | "text") =>
    Math.min(limits.maxBytes[kind], runtimeMax.maxBytes[kind]);

  const payloadCeiling = Math.min(limits.payloadBytes, runtimeMax.payloadBytes);

  integer(options.backends.length, LIMITS.backends, 1);
  const backends = [...options.backends];
  const ids = new Set<string>();

  for (const backend of backends) {
    bounded(backend.id);
    bounded(backend.version);

    if (ids.has(backend.id)) throw new Error("DUPLICATE_EXTRACT_BACKEND");

    if (backend.id === UNSUPPORTED_BACKEND) throw new Error("INVALID_EXTRACT_ARGUMENT");

    ids.add(backend.id);
  }

  if (typeof options.authorize !== "function") throw new Error("EXTRACT_AUTHORIZE_REQUIRED");

  if (options.autoIndex && !options.rag) throw new Error("EXTRACT_RAG_DISABLED");

  if (options.rag) {
    integer(options.rag.embeddingDimension, LIMITS.embeddingDimension, 1);

    integer(
      options.rag.chunk?.maxBytes ?? LIMITS.chunkBytes,
      LIMITS.chunkBytes,
      LIMITS.minChunkBytes,
    );

    if (!LIMITS.embeddingDimensions.includes(options.rag.embeddingDimension as never))
      throw new Error("INVALID_EXTRACT_ARGUMENT");

    if (
      typeof options.rag.embedding === "string" ||
      options.rag.embedding.specificationVersion === "v2"
    )
      throw new Error("EXTRACT_MODEL_INSTANCE_REQUIRED");
  }

  const rag = options.rag
    ? new RAG(options.rag.component, {
        textEmbeddingModel: wrapEmbeddingModel({
          model: options.rag.embedding as Parameters<typeof wrapEmbeddingModel>[0]["model"],
          middleware: {
            wrapEmbed: async ({ doEmbed }) => {
              // RAG does not expose AI SDK maxRetries. Replacing the provider's error
              // with a sanitized, non-retryable error prevents AI SDK's default retry
              // strategy from paying twice after an ambiguous embedding failure.
              try {
                return await doEmbed();
              } catch {
                throw new ExtractError("PROVIDER_UNAVAILABLE");
              }
            },
          },
        }),
        embeddingDimension: options.rag.embeddingDimension,
      })
    : undefined;

  async function authorize(ctx: ActionCtx, scope: Scope) {
    bounded(scope.threadId);

    if (scope.fileId !== undefined) bounded(scope.fileId);

    if (scope.namespace !== undefined) bounded(scope.namespace);

    if (scope.subject !== undefined) bounded(scope.subject);

    await options.authorize(ctx, scope);
  }
  async function fileInfo(ctx: ActionCtx, fileId: string) {
    try {
      // Agent 0.7.7 src/vercel/client/files.ts:157 reads one exact file row;
      // storeFile at :40 owns hash dedupe/refcounts. No transcript scans or file
      // ownership copies are needed; the host verifies its exact attachment.
      const value = await getFile(ctx, options.agent, fileId);
      const meta = await ctx.runQuery(options.storageMetadata, { storageId: value.file.storageId });

      if (!meta) throw new ExtractError("OBJECT_UNAVAILABLE");

      const info: FileInfo = {
        fileId,
        mimeType: value.filePart.mediaType,
        byteSize: meta.size,
        hash: value.file.hash,
        ...(value.file.filename ? { filename: value.file.filename } : {}),
      };

      return { info, storage: value.file.storageId };
    } catch {
      throw new ExtractError("OBJECT_UNAVAILABLE");
    }
  }
  async function identity(ctx: ActionCtx, args: FileArgs) {
    bounded(args.fileId);

    if (args.backend !== undefined) bounded(args.backend);

    const file = await fileInfo(ctx, args.fileId);
    const selected = args.backend ?? options.route?.(file.info);

    const backend = selected
      ? backends.find((value) => value.id === selected)
      : backends.find((value) => value.accepts(file.info));

    const supported = !!backend && backend.accepts(file.info);

    // An explicitly requested backend that cannot take the file is a caller
    // error. When nothing accepts the file at all, the identity is a fixed
    // "unsupported" receipt (see `run`) so an attachment never fails a turn.
    if (!supported && args.backend !== undefined) throw new ExtractError("UNSUPPORTED_TYPE");

    // An indexing-only lease change must not create another paid extraction
    // identity. Keep the extraction ceilings as the identity's options input.
    const optionsHash =
      args.optionsHash ??
      (await fingerprint({ maxBytes: limits.maxBytes, payloadBytes: limits.payloadBytes }));

    if (!/^[a-f0-9]{64}$/.test(optionsHash)) throw new Error("INVALID_EXTRACT_ARGUMENT");

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
  async function raw(
    ctx: ActionCtx,
    args: ArtifactArgs,
    operation: Scope["operation"] = "read",
    namespace?: string,
  ) {
    bounded(args.artifactId);
    const row = await ctx.runQuery(component.artifacts.get, { artifactId: args.artifactId });

    if (!row) throw new ExtractError("OBJECT_UNAVAILABLE");

    await authorize(ctx, {
      operation,
      threadId: args.threadId,
      fileId: row.fileId,
      ...(namespace === undefined ? {} : { namespace }),
      ...subjectOf(args),
    });

    return row;
  }
  function view(row: NonNullable<Awaited<ReturnType<typeof raw>>>) {
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
  /** Authorize, require `ready`, and learn the payload size without reading the payload. */
  async function payloadRef(ctx: ActionCtx, args: ArtifactArgs) {
    const row = await raw(ctx, args);

    if (row.status !== "ready" || !row.payloadStorageId) throw new Error("EXTRACT_NOT_READY");

    const meta = await ctx.runQuery(options.storageMetadata, { storageId: row.payloadStorageId });

    if (!meta) throw new ExtractError("OBJECT_UNAVAILABLE");

    return { row, storage: row.payloadStorageId, size: meta.size };
  }
  /**
   * One blob read, one UTF-8 decode and one JSON parse; nothing else copies the
   * payload. Size is checked from metadata before the read and again on the
   * actual blob, against this runtime's ceiling (LIMITS has the arithmetic).
   */
  async function readPayload(ctx: ActionCtx, ref: Awaited<ReturnType<typeof payloadRef>>) {
    if (ref.size > payloadCeiling) throw new ExtractError("TOO_LARGE");

    const blob = await ctx.storage.get(storageId(ref.storage));

    if (!blob) throw new ExtractError("OBJECT_UNAVAILABLE");

    if (blob.size > payloadCeiling) throw new ExtractError("TOO_LARGE");

    let value: unknown;

    try {
      value = JSON.parse(await blob.text());
    } catch {
      throw new ExtractError("INVALID_OUTPUT");
    }

    return readDocument(value);
  }
  async function record(
    ctx: ActionCtx,
    args: { artifactId?: string; fileId?: string; threadId: string; backend: string },
    usage?: ProviderUsage,
  ) {
    if (usage && options.usage) await options.usage.record(ctx, { ...args, usage });
  }
  /**
   * Hash a stored blob in streamed chunks. `crypto.subtle.digest` needs the
   * whole file as one more ArrayBuffer (N extra bytes); the incremental hasher
   * is constant space, so the checksum adds nothing to the arithmetic in LIMITS.
   */
  async function verifiedBlob(
    ctx: ActionCtx,
    file: { info: FileInfo; storage: string },
    max: number,
  ) {
    const blob = await ctx.storage.get(storageId(file.storage));

    if (!blob) throw new ExtractError("OBJECT_UNAVAILABLE");

    if (blob.size > max) throw new ExtractError("TOO_LARGE");

    const hash = sha256.create();
    const reader = blob.stream().getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      hash.update(value);
    }

    if (bytesToHex(hash.digest()) !== file.info.hash) throw new ExtractError("CHECKSUM_FAILED");

    return blob;
  }
  async function execute(ctx: ActionCtx, args: WorkerArgs): Promise<null> {
    const fence = { artifactId: args.artifactId, attempt: args.attempt, claim: args.claim };

    if (!(await ctx.runMutation(component.artifacts.start, fence))) return null;

    let usage: ProviderUsage | undefined;
    let payloadStorageId: GenericId<"_storage"> | undefined;
    let committed = false;
    let fileId: string | undefined;
    let backendId = "unavailable";

    // A host refusal BEFORE the provider is called (file detached, policy
    // unavailable, transient host error) is not an unknown paid outcome: it is a
    // retryable object failure.
    // Mapping it keeps the row `failed` so an explicit admission can try again,
    // instead of stranding it in `unknown`, which is never rerun.
    const allowed = async (id: string) => {
      try {
        await authorize(ctx, {
          operation: "execute",
          threadId: args.threadId,
          fileId: id,
          ...subjectOf(args),
        });
      } catch {
        throw new ExtractError("OBJECT_UNAVAILABLE");
      }
    };

    try {
      const row = await ctx.runQuery(component.artifacts.get, { artifactId: args.artifactId });

      if (!row) throw new ExtractError("OBJECT_UNAVAILABLE");

      fileId = row.fileId;
      backendId = row.backend;
      await allowed(fileId);

      const backend = backends.find(
        (value) => value.id === row.backend && value.version === row.version,
      );

      if (!backend) throw new ExtractError("UNSUPPORTED_TYPE");

      const file = await fileInfo(ctx, fileId);
      const max = ceiling(kindOf(file.info.mimeType));

      if (file.info.byteSize > max) throw new ExtractError("TOO_LARGE");

      let cached: Promise<Blob> | undefined;
      const bytes = () => (cached ??= verifiedBlob(ctx, file, max));

      const result: BackendResult = await backend.run({
        bytes,
        file: file.info,
        signal: AbortSignal.timeout(LIMITS.providerMs),
        payloadBytes: payloadCeiling,
      });

      usage = cleanUsage(result.usage);

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

        if (!codes.has(result.failure)) throw new ExtractError("INVALID_OUTPUT");

        await ctx.runMutation(component.artifacts.complete, {
          ...fence,
          failure: result.failure,
          ...(usage ? { usage } : {}),
        });
      } else {
        const { doc, blob } = document(result.doc, payloadCeiling);

        payloadStorageId = await ctx.storage.store(blob);

        committed = await ctx.runMutation(component.artifacts.complete, {
          ...fence,
          payloadStorageId,
          summary: {
            kind: doc.kind,
            textBytes: utf8(doc.text).length,
            pages: doc.pages?.length ?? 0,
            preview: sliceText(doc.text, LIMITS.summaryBytes),
            ...(doc.language ? { language: doc.language } : {}),
          },
          ...(usage ? { usage } : {}),
        });
      }
    } catch (error) {
      await ctx.runMutation(component.artifacts.complete, {
        ...fence,
        ...(error instanceof ExtractError ? { failure: error.code } : { unknown: true }),
        ...(usage ? { usage } : {}),
      });
    } finally {
      // A failed commit may have an unknown outcome; deleting its blob then
      // would corrupt a successful row. Read the exact row before cleanup.
      if (payloadStorageId && !committed) {
        const row = await ctx.runQuery(component.artifacts.get, { artifactId: args.artifactId });

        if (row?.payloadStorageId !== payloadStorageId) await ctx.storage.delete(payloadStorageId);
      }

      await record(
        ctx,
        { artifactId: args.artifactId, fileId, threadId: args.threadId, backend: backendId },
        usage,
      );
    }

    if (options.autoIndex && committed) {
      // Index into the admitting thread's namespace. A failure leaves the
      // extraction ready and is recorded on the index row; search simply
      // returns nothing until an explicit `index` or a later `run` retries.
      try {
        await api.index(ctx, {
          artifactId: args.artifactId,
          threadId: args.threadId,
          ...subjectOf(args),
          namespace: args.threadId,
          key: AUTO_INDEX_KEY,
          automatic: true,
        });
      } catch {
        // Intentionally ignored: see above.
      }
    }

    return null;
  }
  /** Validate and run one windowed read; delegates oversized payloads to the Node runtime. */
  async function readWindow(ctx: ActionCtx, request: NodeReadArgs): Promise<unknown> {
    bounded(request.artifactId);
    const max = integer(request.maxBytes ?? LIMITS.readBytes, LIMITS.readBytes, 1);

    if (request.kind === "text") integer(request.cursor ?? 0, LIMITS.node.payloadBytes);

    const from = integer(request.from ?? 1, LIMITS.totalPages, 1);
    const count = integer(request.count ?? LIMITS.pages, LIMITS.pages, 1);
    const cursor = integer(request.cursor ?? 0, LIMITS.node.payloadBytes);
    const ref = await payloadRef(ctx, request);

    if (!nodeRuntime && options.node && ref.size > LIMITS.payloadBytes)
      return ctx.runAction(options.node.read, request);

    const doc = await readPayload(ctx, ref);

    if (request.kind === "text") return textWindow(doc.text, cursor, max);

    const source = doc.pages?.length ? doc.pages : [{ number: 1, text: doc.text }];
    const pages: { number: number; text: string }[] = [];
    let remaining = max;
    let next: { from: number; cursor: number } | null = null;

    // At most 100 pages AND 1 MiB text total, even when a single page is huge.
    // Payload parsing is an action storage read, not a DB transaction.
    for (const page of source.slice(from - 1, from - 1 + count)) {
      if (remaining === 0) {
        next = { from: page.number, cursor: 0 };
        break;
      }

      let window;

      try {
        window = textWindow(page.text, page.number === from ? cursor : 0, remaining);
      } catch (error) {
        if (
          pages.length &&
          error instanceof Error &&
          error.message === "EXTRACT_WINDOW_TOO_SMALL"
        ) {
          next = { from: page.number, cursor: 0 };
          break;
        }

        throw error;
      }

      pages.push({ number: page.number, text: window.text });
      remaining -= utf8(window.text).length;

      if (!window.done) {
        next = { from: page.number, cursor: window.cursor! };
        break;
      }

      next = page.number < source.length ? { from: page.number + 1, cursor: 0 } : null;
    }

    return { pages, next };
  }

  const api = {
    async run(ctx: ActionCtx, args: FileArgs & { onComplete?: Completion }) {
      await authorize(ctx, {
        operation: "run",
        threadId: args.threadId,
        fileId: args.fileId,
        ...subjectOf(args),
      });

      const { key, file, backend } = await identity(ctx, args);

      if (!backend) {
        // No backend accepts this file: record the terminal failure without any
        // provider call and return normally, so a turn with such an attachment
        // still completes. `read_file` then returns the typed error.
        const artifactId = await ctx.runMutation(component.artifacts.reject, {
          ...key,
          failure: "UNSUPPORTED_TYPE",
        });

        return { artifactId, action: "reuse" as const };
      }

      // Files above the default runtime's ceiling can only be extracted by the
      // opt-in Node worker; without one the default worker records TOO_LARGE.
      const worker =
        options.node && file.info.byteSize > LIMITS.maxBytes[kindOf(file.info.mimeType)]
          ? options.node.execute
          : options.worker;

      return ctx.runMutation(component.artifacts.admit, {
        ...key,
        threadId: args.threadId,
        ...subjectOf(args),
        worker: await createFunctionHandle(worker),
        ...(args.onComplete ? { onComplete: await createFunctionHandle(args.onComplete) } : {}),
      });
    },
    async get(ctx: ActionCtx, args: FileArgs | ArtifactArgs) {
      if ("artifactId" in args) return view(await raw(ctx, args, "get"));

      await authorize(ctx, {
        operation: "get",
        threadId: args.threadId,
        fileId: args.fileId,
        ...subjectOf(args),
      });

      const { key } = await identity(ctx, args);
      const row = await ctx.runQuery(component.artifacts.lookup, key);

      return row ? view(row) : null;
    },
    /**
     * Remove one namespace's index of a shared extraction: the caller's thread
     * namespace by default. The extraction and every other namespace's index
     * stay. Use `purge` for storage cleanup.
     */
    async release(ctx: ActionCtx, args: ArtifactArgs & { namespace?: string }) {
      const namespace = bounded(args.namespace ?? args.threadId);
      const row = await raw(ctx, args, "release", namespace);

      const released = await ctx.runMutation(component.indexing.release, {
        artifactId: row._id,
        namespace,
      });

      if (!released) return null;

      // Exact-id native deletion, then drop the fenced record. A crash between
      // the two leaves a `released` record whose entry id is still known, so a
      // repeated release (or a later index admission) finishes the cleanup.
      if (released.entryId && rag) {
        const entry = { entryId: released.entryId as EntryId };

        if (await rag.getEntry(ctx, entry)) await rag.delete(ctx, entry);
      }

      await ctx.runMutation(component.indexing.forget, released);

      return null;
    },
    /**
     * ADMIN operation, not an agent or per-thread one. Agent dedupes uploads by
     * hash, so every thread and uploader that attached the same bytes shares
     * these extractions. Purge tombstones all extractions of `fileId` (the
     * no-repeat receipt and reported usage stay), deletes their payload blobs,
     * and removes the RAG content of every namespace that indexed them: each
     * index record is fenced, its native entry deleted by exact id, and the
     * record dropped, so no orphaned chunks or vectors remain. It performs no
     * `authorize` call: expose it only behind your own admin check.
     *
     * Work per call is bounded (at most LIMITS.purgeBatch index records) and
     * nothing reschedules itself: loop until `more` is false.
     * `do { r = await extract.purge(ctx, { fileId }); } while (r.more);`
     */
    async purge(ctx: ActionCtx, args: { fileId: string }): Promise<{ more: boolean }> {
      bounded(args.fileId);
      let budget: number = LIMITS.purgeBatch;
      let more = false;
      let after: number | null = 0;

      walk: do {
        const page: { storageIds: string[]; artifactIds: string[]; next: number | null } =
          await ctx.runMutation(component.artifacts.purge, { fileId: args.fileId, after });

        for (const id of page.storageIds) await ctx.storage.delete(storageId(id));

        if (rag) {
          for (const artifactId of page.artifactIds) {
            for (;;) {
              if (budget === 0) {
                more = true;
                break walk;
              }

              const batch: {
                entries: { indexId: string; entryId: string | null }[];
                more: boolean;
              } = await ctx.runMutation(component.indexing.purgeBatch, {
                artifactId,
                limit: budget,
              });

              for (const released of batch.entries) {
                if (released.entryId) {
                  const entry = { entryId: released.entryId as EntryId };

                  if (await rag.getEntry(ctx, entry)) await rag.delete(ctx, entry);
                }

                await ctx.runMutation(component.indexing.forget, released);
              }

              budget -= batch.entries.length;

              if (!batch.more) break;
            }
          }
        }

        after = page.next;
      } while (after !== null);

      return { more };
    },
    async readText(ctx: ActionCtx, args: ArtifactArgs & { cursor?: number; maxBytes?: number }) {
      return (await readWindow(ctx, { kind: "text", ...args })) as {
        text: string;
        cursor: number | null;
        done: boolean;
      };
    },
    async readPages(
      ctx: ActionCtx,
      args: ArtifactArgs & { from?: number; count?: number; cursor?: number; maxBytes?: number },
    ) {
      return (await readWindow(ctx, { kind: "pages", ...args })) as {
        pages: { number: number; text: string }[];
        next: { from: number; cursor: number } | null;
      };
    },
    async fromUrl(ctx: ActionCtx, args: Scoped & { url: string }) {
      await authorize(ctx, { operation: "fromUrl", threadId: args.threadId, ...subjectOf(args) });
      bounded(args.url, LIMITS.urlBytes);
      let url: URL;

      try {
        url = new URL(args.url);
      } catch {
        throw new Error("INVALID_EXTRACT_ARGUMENT");
      }

      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("INVALID_EXTRACT_ARGUMENT");

      const backend = backends.find((value) => value.fromUrl);

      if (!backend?.fromUrl) throw new ExtractError("UNSUPPORTED_TYPE");

      const result = await backend.fromUrl(
        args.url,
        AbortSignal.timeout(LIMITS.providerMs),
        payloadCeiling,
      );

      const usage = cleanUsage(result.usage);

      // Account before validation/storage: a failed parse or oversized fetched
      // result still consumed the provider's reported credits.
      await record(ctx, { threadId: args.threadId, backend: backend.id }, usage);

      if (!result.ok) throw new ExtractError(result.failure);

      const { doc } = document(result.doc, payloadCeiling);

      if (utf8(doc.text).length > ceiling("text")) throw new ExtractError("TOO_LARGE");

      const saved = await storeFile(
        ctx,
        options.agent,
        new Blob([doc.text], { type: "text/markdown" }),
        { filename: "web-page.md" },
      );

      return { fileId: saved.file.fileId, ...(usage ? { usage } : {}) };
    },
    internalFunctions() {
      return {
        storageMetadata: internalQueryGeneric({
          args: { storageId: v.string() },
          returns: v.union(v.null(), v.object({ size: v.number() })),
          handler: async (ctx, args) => {
            const meta = await ctx.db.system.get("_storage", storageId(args.storageId));

            return meta ? { size: meta.size } : null;
          },
        }),
        execute: internalActionGeneric({
          args: {
            artifactId: v.string(),
            attempt: v.number(),
            claim: v.string(),
            threadId: v.string(),
            subject: v.optional(v.string()),
          },
          returns: v.null(),
          handler: execute,
        }),
      };
    },
    /** The Node runtime's windowed read; see extractNodeExport. */
    nodeRead: (ctx: ActionCtx, request: NodeReadArgs) => readWindow(ctx, request),
    /**
     * The agevex `extract` slot (`registerAgent(..., { extract: extract.slot() })`).
     * Core calls `run` once per attached file at the first slice of a turn and
     * binds `tools` to the running thread and subject; see ./adapter.ts.
     * `search_files` is offered only with `autoIndex`: without it nothing would
     * ever fill the thread's namespace.
     */
    slot(): ExtractSlot {
      return extractSlot(api, !!options.autoIndex);
    },
    tools(context: Scoped & { ctx: ActionCtx }): ToolSet {
      bounded(context.threadId);

      if (context.subject !== undefined) bounded(context.subject);

      const owner = subjectOf(context);

      const read_file = tool({
        description:
          "Read bounded extracted file text. The file must be attached to this thread. Pass the returned next arguments to continue reading.",
        inputSchema: z.object({
          fileId: z.string().min(1).max(LIMITS.identifierBytes),
          page: z.number().int().min(1).max(LIMITS.totalPages).optional(),
          cursor: z.number().int().nonnegative().max(LIMITS.node.payloadBytes).optional(),
        }),
        execute: async ({ fileId, page, cursor }) => {
          const artifact = await api.get(context.ctx, {
            fileId,
            threadId: context.threadId,
            ...owner,
          });

          if (!artifact || artifact.status !== "ready")
            return {
              status: artifact?.status ?? "missing",
              // The typed failure (for example UNSUPPORTED_TYPE) is what the
              // model can act on; provider bodies never reach this field.
              ...(artifact?.failure ? { error: artifact.failure.code } : {}),
            };

          const args = {
            artifactId: artifact.artifactId,
            threadId: context.threadId,
            ...owner,
            maxBytes: LIMITS.toolBytes,
            cursor,
          };

          if (page !== undefined) {
            const result = await api.readPages(context.ctx, { ...args, from: page, count: 1 });

            return {
              text: result.pages[0]?.text ?? "",
              references: [{ fileId, artifactId: artifact.artifactId, page }],
              next: result.next
                ? { fileId, page: result.next.from, cursor: result.next.cursor }
                : null,
            };
          }

          const result = await api.readText(context.ctx, args);

          return {
            ...result,
            references: [{ fileId, artifactId: artifact.artifactId }],
            next: result.cursor === null ? null : { fileId, cursor: result.cursor },
          };
        },
      });

      if (!rag) return { read_file } satisfies ToolSet;

      const search_files = tool({
        description:
          "Search indexed files in this thread, returning bounded text and file references.",
        inputSchema: z.object({ query: z.string().min(1).max(LIMITS.queryBytes) }),
        execute: async ({ query }) =>
          api.search(context.ctx, {
            threadId: context.threadId,
            ...owner,
            namespace: context.threadId,
            query,
          }),
      });

      return { read_file, search_files } satisfies ToolSet;
    },
    /**
     * Index a ready artifact's text into `namespace`. `automatic: true` (the
     * slot and the worker) only creates a missing record: it never re-runs a
     * failed, unknown, released or key-changed index, because that repeats paid
     * embedding; only an explicit call (without it) recovers those.
     */
    async index(
      ctx: ActionCtx,
      args: ArtifactArgs & { namespace: string; key: string; automatic?: boolean },
    ) {
      if (!rag || !options.rag) throw new Error("EXTRACT_RAG_DISABLED");

      bounded(args.key);

      await authorize(ctx, {
        operation: "index",
        threadId: args.threadId,
        namespace: args.namespace,
        ...subjectOf(args),
      });

      const ref = await payloadRef(ctx, args);
      const row = ref.row;

      // Decide from the index record BEFORE loading or chunking the payload: an
      // already-ready (or live) index must not cost a payload read, and an
      // automatic caller never re-embeds. The admit mutation re-checks all of
      // this atomically; this read only avoids the wasted load.
      const existing = await ctx.runQuery(component.indexing.lookup, {
        artifactId: row._id,
        namespace: args.namespace,
      });

      if (existing) {
        const live =
          (existing.status === "cleaning" || existing.status === "running") &&
          existing.leaseUntil > Date.now();

        const state =
          existing.status === "ready" && existing.key === args.key
            ? ("ready" as const)
            : live
              ? ("pending" as const)
              : args.automatic
                ? ("skipped" as const)
                : undefined;

        if (state)
          return {
            entryId: existing.entryId,
            status: state,
            created: false,
            replacedEntry: null,
            usage: { tokens: 0 },
          };
      }

      // Decide from the stored summary BEFORE reading the payload: an artifact
      // whose text exceeds the index ceiling must not cost a full payload load.
      if ((row.summary?.textBytes ?? 0) > LIMITS.indexBytes) throw new ExtractError("TOO_LARGE");

      const doc = await readPayload(ctx, ref);
      // Encode once and window over the bytes; re-encoding the text per chunk
      // would cost up to 1,024 full encodings of a 1 MiB text.
      const bytes = utf8(doc.text);

      if (bytes.length > LIMITS.indexBytes) throw new ExtractError("TOO_LARGE");

      const chunks: { text: string }[] = [];
      let cursor: number | null = 0;

      do {
        const window = textWindow(bytes, cursor, options.rag?.chunk?.maxBytes ?? LIMITS.chunkBytes);

        chunks.push({ text: window.text });
        cursor = window.cursor;

        if (chunks.length > LIMITS.indexChunks) throw new ExtractError("TOO_LARGE");
      } while (cursor !== null);

      const admitted = await ctx.runMutation(component.indexing.admit, {
        artifactId: row._id,
        namespace: args.namespace,
        key: args.key,
        leaseMs: limits.indexLeaseMs,
        ...(args.automatic ? { automatic: true } : {}),
      });

      if (admitted.action !== "run")
        return {
          entryId: admitted.entryId,
          status:
            admitted.action === "reuse"
              ? ("ready" as const)
              : admitted.action === "skip"
                ? ("skipped" as const)
                : ("pending" as const),
          created: false,
          replacedEntry: null,
          usage: { tokens: 0 },
        };

      const fence = { indexId: admitted.indexId, claim: admitted.claim };

      try {
        if (admitted.entryId) {
          // RAG 0.7.8 src/client/index.ts:768-786 deletes by exact entry id;
          // entries.ts:511-529 pages chunk deletion before deleting that entry.
          // Await it before creating a replacement; even a partially failed
          // deletion remains addressable on our row for the next explicit retry.
          // The id is this namespace's own record: other namespaces' entries
          // of the same shared extraction are never touched.
          const previous = { entryId: admitted.entryId as EntryId };

          if (await rag.getEntry(ctx, previous)) await rag.delete(ctx, previous);
        }

        const { namespaceId } = await rag.getOrCreateNamespace(ctx, {
          namespace: args.namespace,
          status: "ready",
        });

        const entryId = await ctx.runMutation(component.indexing.start, {
          ...fence,
          add: await createFunctionHandle(options.rag.component.entries.add),
          namespaceId,
          // Caller keys are scoped to the artifact: otherwise independent
          // artifacts using one key could rebuild the same unbounded pending
          // history despite each index record's own admission fence.
          key: await fingerprint({ artifactId: row._id, key: args.key }),
          contentHash: await fingerprint({ artifactId: row._id, claim: row.claim }),
        });

        let tokens = 0;

        // Native RAG add cannot attach to an entry created in our admission
        // transaction (src/client/index.ts:194). Use its public entry/chunk
        // mutations, keeping all durable content/vectors inside RAG instead.
        // Each batch writes 100 content + 100 chunk + 100 vector rows. Text
        // appears in content AND searchableText; Convex numbers cost 9 bytes:
        // 100*(2*8192+4096*9+1024) = 5,427,200 bytes (~5.2 MiB), 300 rows,
        // below 16 MiB/16000. The 1 KiB allowance covers fields/ids per triplet.
        for (let startOrder = 0; startOrder < chunks.length; startOrder += LIMITS.ragBatch) {
          const batch = chunks.slice(startOrder, startOrder + LIMITS.ragBatch);

          const result = await embedMany({
            model: rag.options.textEmbeddingModel,
            values: batch.map(({ text }) => text.trim() || "<empty>"),
            maxRetries: 0,
          });

          tokens += result.usage.tokens;

          const inserted = await ctx.runMutation(component.indexing.insert, {
            ...fence,
            insert: await createFunctionHandle(options.rag.component.chunks.insert),
            startOrder,
            chunks: batch.map(({ text }, index) => ({
              content: { text },
              searchableText: text,
              embedding: result.embeddings[index]!,
            })),
          });

          if (!inserted) throw new Error("EXTRACT_INDEX_FENCED");
        }

        // No authorization re-check after the paid embedding (the check before
        // it already ran, and `index` is refused up front for an unattached
        // file). Discarding the index here would pay again on the next attach;
        // publishing leaks nothing because `search` re-authorizes every hit
        // against the then-current attachment and skips detached files.
        if (
          !(await ctx.runMutation(component.indexing.complete, {
            ...fence,
            promote: await createFunctionHandle(options.rag.component.entries.promoteToReady),
          }))
        )
          throw new Error("EXTRACT_INDEX_FENCED");

        return {
          entryId,
          status: "ready" as const,
          created: true,
          replacedEntry: null,
          usage: { tokens },
        };
      } catch (error) {
        await ctx.runMutation(component.indexing.complete, fence);
        throw error;
      }
    },
    async search(
      ctx: ActionCtx,
      args: Scoped & { namespace: string; query: string; limit?: number },
    ) {
      if (!rag) throw new Error("EXTRACT_RAG_DISABLED");

      bounded(args.query, LIMITS.queryBytes);
      const limit = integer(args.limit ?? LIMITS.searchResults, LIMITS.searchResults, 1);

      await authorize(ctx, {
        operation: "search",
        threadId: args.threadId,
        namespace: args.namespace,
        ...subjectOf(args),
      });

      // RAG 0.7.8 src/client/index.ts:368 owns retrieval. No adjacent context:
      // <=10 hits * <=8 KiB own chunks = <=80 KiB upstream text; final tool text
      // <=64 KiB. Use a dedicated RAG mount/namespace for these bounded chunks.
      const result = await rag.search(ctx, {
        namespace: args.namespace,
        query: args.query,
        limit,
        chunkContext: { before: 0, after: 0 },
      });

      const references: { artifactId: string; fileId: string }[] = [];
      let text = "";

      for (const entry of result.entries.slice(0, limit)) {
        const artifactId = entry.metadata?.artifactId;
        const fileId = entry.metadata?.fileId;

        if (typeof artifactId !== "string" || typeof fileId !== "string") continue;

        // A hit whose file is no longer attached (or whose extraction is gone)
        // is skipped, not an error: one stale entry must not fail the whole
        // search and hide the still-attached results.
        try {
          const row = await ctx.runQuery(component.artifacts.get, { artifactId });

          if (!row || row.status !== "ready" || row.fileId !== fileId) continue;

          await authorize(ctx, {
            operation: "search",
            threadId: args.threadId,
            fileId: row.fileId,
            namespace: args.namespace,
            ...subjectOf(args),
          });

          const index = await ctx.runQuery(component.indexing.lookup, {
            artifactId: row._id,
            namespace: args.namespace,
          });

          if (index?.status !== "ready" || index.entryId !== entry.entryId) continue;
        } catch {
          continue;
        }

        const remaining = LIMITS.toolBytes - utf8(text).length;

        if (!remaining) break;

        text += sliceText((text ? "\n" : "") + entry.text, remaining);
        references.push({ artifactId, fileId });
      }

      return { text, references, usage: result.usage };
    },
  };

  return api;
}
