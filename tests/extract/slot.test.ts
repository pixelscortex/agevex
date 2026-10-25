// @vitest-environment edge-runtime
// Integration of the real extract module with `registerAgent` through the core
// `extract` slot: fake model, the module's fake backend, the repo's convex-test
// host with the real Workflow-backed extraction component. No network.
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import workflow from "@convex-dev/workflow/test";
import workpool from "@convex-dev/workpool/test";
import { storeFile } from "@convex-dev/agent";
import type { AgentComponent } from "@convex-dev/agent";
import { makeFunctionReference } from "convex/server";
import type { FunctionReference } from "convex/server";
import agevex from "../../src/test.js";
import extractSchema from "../../src/extract/component/schema.js";
import {
  authorizeAttached,
  defineExtract,
  type ComponentApi,
  type ExtractBackend,
  type ExtractOptions,
  type WorkerArgs,
} from "../../src/extract/index.js";
import schema from "../fixture/schema.js";
import { components } from "../fixture/api.js";
import { fixture, reset, exports, api, registration, text, call } from "../hooks.host.js";
import { requireReceipt } from "../receipt.js";

const hostModules = import.meta.glob(["../fixture/**/*.ts", "../fixture/**/*.js"]);
const extractModules = import.meta.glob("../../src/extract/component/**/*.ts");
const mounts = components as unknown as {
  agent: AgentComponent;
  extract: ComponentApi;
};

const worker = makeFunctionReference<"action", WorkerArgs, null>(
  "extractHost:execute",
) as unknown as FunctionReference<"action", "internal", WorkerArgs, null>;
const storageMetadata = makeFunctionReference<
  "query",
  { storageId: string },
  { size: number } | null
>("extractHost:storageMetadata") as unknown as ExtractOptions["storageMetadata"];

/**
 * One host: core agevex + native Agent + the extract component (with its own
 * nested Workflow/Workpool). `useSlot: false` registers the same agent without
 * the slot, which is the core default (native file parts).
 */
function setup(useSlot = true) {
  const state = { backendCalls: [] as string[] };
  const backend: ExtractBackend = {
    id: "fake",
    version: "1",
    accepts: () => true,
    run: async ({ bytes, file }) => {
      state.backendCalls.push(file.fileId);
      return { ok: true, doc: { kind: "text", text: await (await bytes()).text() } };
    },
  };
  const extract = defineExtract(mounts.extract, {
    agent: mounts.agent,
    worker,
    storageMetadata,
    backends: [backend],
    // Lazy: registration() and defineExtract reference each other.
    authorize: authorizeAttached(() => registration()),
  });
  if (useSlot) fixture.slots.extract = extract.slot();
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: {
      ...hostModules,
      "../fixture/agents.ts": async () => exports(),
      "../fixture/extractHost.ts": async () => extract.internalFunctions(),
    },
  });
  agent.register(t);
  agevex.register(t);
  t.registerComponent("extract", extractSchema, extractModules);
  workflow.register(t, "extract/workflow");
  workpool.register(t, "extract/workflow/workpool");
  return { t, extract, state };
}
type Host = ReturnType<typeof setup>;

const as = (h: Host, subject = "alice") => h.t.withIdentity({ subject });
const open = (h: Host, files: string[], requestKey = "first", subject = "alice") =>
  as(h, subject)
    .mutation(api.agents.open, { agent: "Main", prompt: "hello", requestKey, files })
    .then(requireReceipt);
const send = (h: Host, threadId: string, requestKey: string, files?: string[]) =>
  as(h)
    .mutation(api.agents.send, {
      threadId,
      text: requestKey,
      requestKey,
      ...(files ? { files } : {}),
    })
    .then(requireReceipt);
const drain = (h: Host) => h.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
async function upload(h: Host, content: string, subject = "alice") {
  const file = await h.t.action(
    async (ctx) =>
      (
        await storeFile(ctx, mounts.agent, new Blob([content], { type: "text/plain" }), {
          filename: "doc.txt",
        })
      ).file,
  );
  await h.t.mutation((ctx) =>
    registration().registerFile(ctx, { agent: "Main", fileId: file.fileId, subject }),
  );
  return file.fileId;
}
const artifact = (h: Host, threadId: string, fileId: string) =>
  h.t.action((ctx) => h.extract.get(ctx, { threadId, fileId, subject: "alice" }));
/** Everything the fake model was shown as tool results, as one string. */
const toolOutputs = () =>
  JSON.stringify(
    fixture.calls.flatMap((c) => c.args.prompt).filter((message) => message.role === "tool"),
  );
const hasNativeFilePart = () =>
  fixture.calls.some((c) =>
    c.args.prompt.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === "file"),
    ),
  );

beforeEach(() => {
  reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("open and send with registered files start exactly one extraction per file and none again on replay", async () => {
  const h = setup();
  const a = await upload(h, "alpha document");
  const b = await upload(h, "beta document");
  const receipt = await open(h, [a]);
  await drain(h);
  expect(h.state.backendCalls).toEqual([a]);
  // One file per message: convex-test cannot run two blob-writing actions
  // concurrently ("Write outside of transaction"), which is a harness limit.
  await send(h, receipt.threadId, "second", [b]);
  await drain(h);
  expect(h.state.backendCalls).toEqual([a, b]);
  expect(await artifact(h, receipt.threadId, a)).toMatchObject({ status: "ready" });
  expect(await artifact(h, receipt.threadId, b)).toMatchObject({ status: "ready" });
  // The model sees the files through extraction tools, not as native parts.
  expect(hasNativeFilePart()).toBe(false);
  // The same idempotent requests replayed, then a later message attaching an
  // already extracted file: the module's own admission reuses the identity, so
  // no backend call repeats.
  await open(h, [a]);
  await send(h, receipt.threadId, "second", [b]);
  await send(h, receipt.threadId, "again", [a]);
  await drain(h);
  expect(h.state.backendCalls).toEqual([a, b]);
});

it("the agent's read_file returns the extracted text of an attached file", async () => {
  const h = setup();
  const a = await upload(h, "the secret word is marmalade");
  const receipt = await open(h, [a]);
  await drain(h);
  // Model calls from here on: 1 = read_file, 2 = final answer.
  const before = fixture.calls.length;
  fixture.steps.Main = (n) => (n === before ? call("read_file", { fileId: a }) : text("done"));
  await send(h, receipt.threadId, "read it");
  await drain(h);
  expect(toolOutputs()).toContain("marmalade");
  expect(toolOutputs()).toContain(a);
});

it("read_file refuses a file attached to another thread or another subject", async () => {
  const h = setup();
  const mine = await upload(h, "my own file");
  const sameSubjectOtherThread = await upload(h, "private to thread two: kumquat");
  const foreign = await upload(h, "bob only: persimmon", "bob");
  // One extraction at a time (see the first test's note on the harness limit).
  const first = await open(h, [mine], "t1");
  await drain(h);
  const second = await open(h, [sameSubjectOtherThread], "t2");
  await drain(h);
  const bobs = await open(h, [foreign], "t3", "bob");
  await drain(h);
  // Thread two's file really is extracted and readable on its own thread, so a
  // refusal on thread one is the authorization, not a pending extraction.
  expect(await artifact(h, second.threadId, sameSubjectOtherThread)).toMatchObject({
    status: "ready",
  });
  const before = fixture.calls.length;
  fixture.steps.Main = (n) => {
    const index = n - before;
    return index === 0
      ? call("read_file", { fileId: sameSubjectOtherThread })
      : index === 1
        ? call("read_file", { fileId: foreign })
        : text("done");
  };
  await send(h, first.threadId, "try others");
  await drain(h);
  const shown = toolOutputs();
  expect(shown).not.toContain("kumquat");
  expect(shown).not.toContain("persimmon");
  expect(shown).toContain("FORBIDDEN");
  // The same refusal holds when a caller names the wrong subject for a thread.
  await expect(
    h.t.action((ctx) =>
      h.extract.get(ctx, {
        threadId: bobs.threadId,
        fileId: sameSubjectOtherThread,
        subject: "alice",
      }),
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    h.t.action((ctx) =>
      h.extract.get(ctx, { threadId: first.threadId, fileId: mine, subject: "bob" }),
    ),
  ).rejects.toThrow("FORBIDDEN");
  // A caller that names no subject is denied rather than guessed.
  await expect(
    h.t.action((ctx) => h.extract.get(ctx, { threadId: first.threadId, fileId: mine })),
  ).rejects.toThrow("FORBIDDEN");
});

it("without the slot attached files reach the model as native file parts", async () => {
  const h = setup(false);
  const a = await upload(h, "native file");
  await open(h, [a]);
  await drain(h);
  expect(hasNativeFilePart()).toBe(true);
  expect(h.state.backendCalls).toEqual([]);
});
