/**
 * Public contracts for extraction backends, host authorization, usage, and registration.
 * Hosts supply exact attachment checks and internal worker/metadata references.
 * Types describe storage-backed documents without importing host code into the component.
 */
import type { AgentComponent } from "@convex-dev/agent";
import type { RAG } from "@convex-dev/rag";
import type { FunctionReference, GenericActionCtx, GenericDataModel } from "convex/server";
import type { Infer } from "convex/values";
import type { failure, usage } from "../component/schema.js";
import type { ExtractLimits } from "../shared/limits.js";

export type ExtractFailure = Infer<typeof failure>;
export type ProviderUsage = Infer<typeof usage>;
export type Page = { number: number; text: string };
export type ExtractedDoc = {
  kind: "text" | "document" | "image";
  text: string;
  pages?: Page[];
  language?: string;
};
export type FileInfo = {
  fileId: string;
  mimeType: string;
  byteSize: number;
  filename?: string;
  hash: string;
};
export type BackendInput = {
  bytes: () => Promise<Blob>;
  file: FileInfo;
  signal: AbortSignal;
  /** Largest serialized payload this runtime accepts; bound provider responses by it. */
  payloadBytes?: number;
};
export type BackendResult =
  | { ok: true; doc: ExtractedDoc; usage?: ProviderUsage }
  | { ok: false; failure: ExtractFailure; usage?: ProviderUsage };
export type ExtractBackend = {
  id: string;
  version: string;
  accepts(file: Pick<FileInfo, "mimeType" | "byteSize">): boolean;
  run(input: BackendInput): Promise<BackendResult>;
  /** Firecrawl URL acquisition is separate from parsing an already stored file. */
  fromUrl?: (url: string, signal: AbortSignal, payloadBytes?: number) => Promise<BackendResult>;
};
export type ActionCtx = GenericActionCtx<GenericDataModel>;
export type Scope = {
  operation: "run" | "get" | "read" | "release" | "fromUrl" | "index" | "search" | "execute";
  threadId: string;
  fileId?: string;
  namespace?: string;
  /** Present when the caller knows the thread owner (the agevex slot's tools do). */
  subject?: string;
};
export type WorkerArgs = {
  artifactId: string;
  attempt: number;
  claim: string;
  threadId: string;
  /** The subject given to `run`, carried in the workflow args (not the artifacts table). */
  subject?: string;
};
/** Arguments of the Node runtime's windowed read (see extractNodeExport). */
export type NodeReadArgs = {
  kind: "text" | "pages";
  threadId: string;
  subject?: string;
  artifactId: string;
  cursor?: number;
  maxBytes?: number;
  from?: number;
  count?: number;
};
export type ExtractOptions = {
  agent: AgentComponent;
  backends: readonly ExtractBackend[];
  storageMetadata: FunctionReference<
    "query",
    "internal",
    { storageId: string },
    { size: number } | null
  >;
  worker: FunctionReference<"action", "internal", WorkerArgs, null>;
  /**
   * Opt-in "use node" (512 MiB) actions from `extractNodeExport`. Files above
   * the default runtime's byte ceilings are dispatched to `execute`, and
   * payloads above its read ceiling are read by `read`. Registering them also
   * raises the hard maxima of `limits` to LIMITS.node (50 MB / 32 MiB).
   */
  node?: {
    execute: FunctionReference<"action", "internal", WorkerArgs, null>;
    read: FunctionReference<"action", "internal", NodeReadArgs, unknown>;
  };
  /**
   * With `rag`, index each file into the thread's namespace as soon as its
   * extraction is ready (in the worker after a fresh extraction, in
   * `slot.run` when the extraction already exists), so the slot's
   * `search_files` has something to search. Default false.
   */
  autoIndex?: boolean;
  /** Must verify thread access AND the exact file attachment, without listing transcripts. */
  authorize: (ctx: ActionCtx, scope: Scope) => Promise<void>;
  route?: (file: FileInfo) => string | undefined;
  limits?: Partial<Omit<ExtractLimits, "maxBytes">> & {
    maxBytes?: Partial<ExtractLimits["maxBytes"]>;
  };
  usage?: {
    record: (
      ctx: ActionCtx,
      event: {
        artifactId?: string;
        fileId?: string;
        threadId: string;
        backend: string;
        usage: ProviderUsage;
      },
    ) => Promise<void>;
  };
  rag?: {
    component: ConstructorParameters<typeof RAG>[0];
    embedding: ConstructorParameters<typeof RAG>[1]["textEmbeddingModel"];
    embeddingDimension: number;
    chunk?: { maxBytes: number };
  };
};
