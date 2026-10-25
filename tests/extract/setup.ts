/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import {
  defineSchema,
  componentsGeneric,
  makeFunctionReference,
  internalMutationGeneric,
} from "convex/server";
import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import agent from "@convex-dev/agent/test";
import workflow from "@convex-dev/workflow/test";
import workpool from "@convex-dev/workpool/test";

import { storeFile, mockModel } from "@convex-dev/agent";
import type { AgentComponent } from "@convex-dev/agent";
import {
  defineExtract,
  extractNodeExport,
  type ComponentApi,
  type ExtractBackend,
  type ExtractOptions,
  type WorkerArgs,
  type NodeReadArgs,
} from "../../src/extract/index.js";
import schema from "../../src/extract/component/schema.js";
import type { ActionCtx } from "../../src/extract/types.js";

const hostModules = import.meta.glob("./fixture/**/*.ts");
const modules = import.meta.glob("../../src/extract/component/**/*.ts");
const mounts = componentsGeneric();
export const component = mounts.extract as unknown as ComponentApi;
export const agentComponent = mounts.agent as unknown as AgentComponent;
export const worker = makeFunctionReference<"action", WorkerArgs, null>(
  "host:execute",
) as unknown as FunctionReference<"action", "internal", WorkerArgs, null>;
export const storageMetadata = makeFunctionReference<
  "query",
  { storageId: string },
  { size: number } | null
>("host:storageMetadata") as unknown as ExtractOptions["storageMetadata"];
const nodeWorker = makeFunctionReference<"action", WorkerArgs, null>(
  "host:nodeExecute",
) as unknown as NonNullable<ExtractOptions["node"]>["execute"];
const nodeRead = makeFunctionReference<"action", NodeReadArgs, unknown>(
  "host:nodeRead",
) as unknown as NonNullable<ExtractOptions["node"]>["read"];
export function setup(
  input: {
    /** Register the opt-in Node worker/reader (extractNodeExport) as options.node. */
    node?: boolean;
    autoIndex?: boolean;
    backends?: ExtractBackend[];
    limits?: ExtractOptions["limits"];
    rag?: ExtractOptions["rag"];
    authorize?: ExtractOptions["authorize"];
  } = {},
) {
  const state = {
    calls: 0,
    completions: [] as string[],
    gate: undefined as Promise<void> | undefined,
    result: undefined as Awaited<ReturnType<ExtractBackend["run"]>> | undefined,
    thrown: false,
    usageFails: false,
    attachments: new Map<string, string>(),
    events: [] as unknown[],
  };
  const backend: ExtractBackend = {
    id: "fake",
    version: "1",
    accepts: () => true,
    run: async ({ bytes }) => {
      state.calls++;
      await state.gate;
      if (state.thrown) throw new Error("SECRET_PROVIDER_BODY");
      return (
        state.result ?? { ok: true, doc: { kind: "text", text: await (await bytes()).text() } }
      );
    },
  };
  const options: ExtractOptions = {
    agent: agentComponent,
    worker,
    storageMetadata,
    backends: input.backends ?? [backend],
    limits: input.limits,
    authorize:
      input.authorize ??
      (async (_ctx, scope) => {
        if (
          scope.threadId !== "owner" ||
          (scope.fileId && state.attachments.get(scope.fileId) !== scope.threadId)
        )
          throw new Error("FORBIDDEN");
      }),
    usage: {
      record: async (_ctx, event) => {
        state.events.push(event);
        if (state.usageFails) throw new Error("HOST_USAGE_UNAVAILABLE");
      },
    },
    rag: input.rag,
    ...(input.autoIndex ? { autoIndex: true } : {}),
    ...(input.node ? { node: { execute: nodeWorker, read: nodeRead } } : {}),
  };
  const extract = defineExtract(component, options);
  const nodeExports = input.node ? extractNodeExport(component, options) : undefined;
  const t = convexTest({
    schema: defineSchema({}),
    transactionLimits: true,
    modules: {
      ...hostModules,
      "./fixture/host.ts": async () => ({
        ...extract.internalFunctions(),
        ...(nodeExports ? { nodeExecute: nodeExports.execute, nodeRead: nodeExports.read } : {}),
        onComplete: internalMutationGeneric({
          args: { artifactId: v.string() },
          returns: v.null(),
          handler: async (ctx, args) => {
            const row = await ctx.runQuery(component.artifacts.get, args);
            state.completions.push(row?.status ?? "missing");
            return null;
          },
        }),
        // A second, distinct caller callback (its handle differs from onComplete's).
        onCompleteWaiter: internalMutationGeneric({
          args: { artifactId: v.string() },
          returns: v.null(),
          handler: async (ctx, args) => {
            const row = await ctx.runQuery(component.artifacts.get, args);
            state.completions.push(`waiter:${row?.status ?? "missing"}`);
            return null;
          },
        }),
      }),
    },
  });
  agent.register(t);
  t.registerComponent("extract", schema, modules);
  workflow.register(t, "extract/workflow");
  workpool.register(t, "extract/workflow/workpool");

  const uploadBlob = async (blob: Blob, filename?: string) => {
    const fileId = await t.action(
      async (ctx) => (await storeFile(ctx, agentComponent, blob, { filename })).file.fileId,
    );
    state.attachments.set(fileId, "owner");
    return fileId;
  };
  const upload = (text = "hello extracted world", type = "text/plain") =>
    uploadBlob(new Blob([text], { type }));
  const action = <T>(fn: (ctx: ActionCtx) => Promise<T>) => t.action(fn);
  return { t, extract, state, upload, uploadBlob, action };
}
export { mockModel };
