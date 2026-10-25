/**
 * Resolved configuration and shared host request contracts.
 * Host actions call these helpers with the resolved runtime context.
 * Durable state stays in the extract component; payload bytes stay in storage.
 */
import { RAG } from "@convex-dev/rag";
import { wrapEmbeddingModel } from "ai";
import type { FunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { LIMITS, bounded, integer, resolveLimits } from "../shared/limits.js";
import { ExtractError, isTextMime } from "./backends.js";
import type { ExtractOptions } from "./types.js";
/**
 * `subject` is the thread owner a caller already knows (the agevex slot's tool
 * context carries it). It is forwarded to the host `authorize` callback so the
 * exact-attachment check can name its subject; background calls (`execute`)
 * have no caller and let the host resolve the owner from the thread instead.
 */
export type Scoped = { threadId: string; subject?: string };

/** Forward an optional subject without writing `subject: undefined` into scopes. */
export const subjectOf = (args: { subject?: string }) =>
  args.subject === undefined ? {} : { subject: args.subject };

export type FileArgs = Scoped & { fileId: string; backend?: string; optionsHash?: string };
export type ArtifactArgs = Scoped & { artifactId: string };
export type Completion = FunctionReference<
  "mutation",
  "internal",
  { artifactId: string },
  null | void
>;
/** Cast an exact storage id at the host boundary; callers handle missing objects explicitly. */
export const storageId = (id: string) => id as GenericId<"_storage">;
/** Fixed identity backend of files that no configured backend accepts. */
export const UNSUPPORTED_BACKEND = "unsupported";
export const retryable = new Set(["PROVIDER_UNAVAILABLE", "OBJECT_UNAVAILABLE", "CHECKSUM_FAILED"]);

/** The runtime-specific byte ceiling (see LIMITS) is chosen by input kind. */
export const kindOf = (mimeType: string): "document" | "image" | "text" =>
  mimeType.startsWith("image/") ? "image" : isTextMime(mimeType) ? "text" : "document";

export type RuntimeContext = ReturnType<typeof resolveRuntime>;

/** Resolve registration options once; actions receive the same bounds and model. */
export function resolveRuntime(
  component: ComponentApi,
  options: ExtractOptions,
  nodeRuntime: boolean,
) {
  // Registering the Node actions (or being one) lifts the hard maxima of the
  // configurable byte limits; each runtime still enforces only its own ceiling.
  const limits = resolveLimits(options.limits, nodeRuntime || !!options.node);
  const runtimeMax = nodeRuntime ? LIMITS.node : LIMITS;

  const ceiling = (kind: "document" | "image" | "text") =>
    Math.min(limits.maxBytes[kind], runtimeMax.maxBytes[kind]);

  const payloadCeiling = Math.min(limits.payloadBytes, runtimeMax.payloadBytes);

  const backends = validateBackends(options);

  if (typeof options.authorize !== "function") throw new Error("EXTRACT_AUTHORIZE_REQUIRED");

  if (options.autoIndex && !options.rag) throw new Error("EXTRACT_RAG_DISABLED");

  validateRag(options);
  const rag = createRag(options);

  return { component, options, nodeRuntime, limits, backends, ceiling, payloadCeiling, rag };
}

/** Snapshot and validate backend identities at registration, before any work is admitted. */
function validateBackends(options: ExtractOptions) {
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

  return backends;
}
/** Reject invalid embedding models and chunk bounds before constructing RAG. */
function validateRag(options: ExtractOptions) {
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
}
/** Disable implicit provider retries so an ambiguous embedding cannot be paid twice. */
function createRag(options: ExtractOptions) {
  return options.rag
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
}
/** Bind one named operation to the resolved context without changing its host signature. */
export function bindRuntime<Args extends unknown[], Result>(
  runtime: RuntimeContext,
  operation: (runtime: RuntimeContext, ...args: Args) => Result,
) {
  return (...args: Args) => operation(runtime, ...args);
}
