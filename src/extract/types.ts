import type { AgentComponent } from "@convex-dev/agent";
import type { GenericActionCtx, GenericDataModel, FunctionReference } from "convex/server";
import type { RAG } from "@convex-dev/rag";
import type { Infer } from "convex/values";
import type { failure, usage } from "./component/schema.js";
import type { ExtractLimits } from "./limits.js";

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
export type BackendInput = { bytes: () => Promise<Blob>; file: FileInfo; signal: AbortSignal };
export type BackendResult =
  | { ok: true; doc: ExtractedDoc; usage?: ProviderUsage }
  | { ok: false; failure: ExtractFailure; usage?: ProviderUsage };
export type ExtractBackend = {
  id: string;
  version: string;
  accepts(file: Pick<FileInfo, "mimeType" | "byteSize">): boolean;
  run(input: BackendInput): Promise<BackendResult>;
  /** Firecrawl URL acquisition is separate from parsing an already stored file. */
  fromUrl?: (url: string, signal: AbortSignal) => Promise<BackendResult>;
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
export type WorkerArgs = { artifactId: string; attempt: number; claim: string; threadId: string };
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
