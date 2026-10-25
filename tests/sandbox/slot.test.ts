// @vitest-environment edge-runtime
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import agevex from "../../src/test.js";
import sandboxModule from "../../src/sandbox/test.js";
import schema from "../fixture/schema.js";
import { requireReceipt } from "../receipt.js";
import { LIMITS } from "../../src/sandbox/index.js";
import { fakeSandboxProvider } from "../../src/testing/sandbox.js";
import { fixture, reset, exports, wiring, api, call, text } from "./slot.host.js";

const modules = import.meta.glob(["./slot/**/*.ts"]);
function setup() {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: { ...modules, "./slot/agents.ts": async () => exports() },
  });
  agent.register(t);
  agevex.register(t);
  return { t, component: sandboxModule.register(t) };
}
type Setup = ReturnType<typeof setup>;
const as = (s: Setup, subject: string) => s.t.withIdentity({ subject });
const open = (s: Setup, subject = "alice", agentName = "Main", requestKey = "first") =>
  as(s, subject)
    .mutation(api.agents.open, { agent: agentName, prompt: "hello", requestKey })
    .then(requireReceipt);
const send = (s: Setup, subject: string, threadId: string, requestKey: string) =>
  as(s, subject).mutation(api.agents.send, { threadId, text: "next", requestKey });
const drain = (s: Setup) =>
  s.t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
const notes = async (s: Setup, subject: string, threadId: string) =>
  (
    await as(s, subject).query(api.agents.messages, {
      threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    })
  ).page.filter((message) => message.origin === "note");
/** The sandbox row the module keeps for these trusted facts, if any. */
const binding = async (s: Setup, subject: string, threadId: string) =>
  s.t.query(s.component.state.get, {
    scopeKey: await wiring().sandbox.scopeKey({ subject, threadId, runId: "unused" }),
  });
const offered = (agentName: string) =>
  (fixture.calls.find((entry) => entry.agent === agentName)?.args.tools ?? [])
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("sandbox_"))
    .sort();

beforeEach(() => {
  reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("sandbox tools reach only agents registered with sandbox: true", async () => {
  const s = setup();
  await open(s, "alice", "Main", "a");
  await open(s, "alice", "Plain", "b");
  await drain(s);
  expect(offered("Main")).toEqual([
    "sandbox_exec",
    "sandbox_list",
    "sandbox_read_file",
    "sandbox_run_background",
    "sandbox_write_file",
  ]);
  expect(offered("Plain")).toEqual([]);
  // Each tool tells the model what it does, not just its own name.
  const tools = fixture.calls.find((entry) => entry.agent === "Main")!.args.tools!;
  for (const tool of tools.filter((tool) => tool.name.startsWith("sandbox_")))
    expect("description" in tool && tool.description!.length > 40).toBe(true);
});

it("a managed sandbox_exec runs in the sandbox bound to the turn's subject and thread", async () => {
  fixture.steps.Main = (n) => (n === 0 ? call("sandbox_exec", { command: "echo hi" }) : text("ok"));
  const s = setup();
  const receipt = await open(s);
  await drain(s);
  expect(fixture.fake.calls.exec).toEqual(["echo hi"]);
  expect(fixture.fake.calls.create).toBe(1);
  // The row is addressable only by this subject + thread, and holds the one
  // sandbox the provider created; the model never named it.
  expect(await binding(s, "alice", receipt.threadId)).toMatchObject({
    sandboxId: "fake-sandbox-1",
    state: "ready",
  });
  expect(await binding(s, "bob", receipt.threadId)).toBeNull();
  // The command's output came back to the model on its next step.
  expect(JSON.stringify(fixture.calls[1].args.prompt)).toContain('"exitCode":0');
});

it("a delegated child works in the root conversation's sandbox", async () => {
  fixture.steps.Main = (n) =>
    n === 0
      ? call("agevex_delegate", { agent: "Builder", task: "write the file" })
      : n === 1
        ? call("sandbox_read_file", { path: "/child.txt" })
        : text("done");
  fixture.steps.Builder = (n) =>
    n === 0
      ? call("sandbox_write_file", { path: "/child.txt", content: "from child" })
      : text("ok");
  const s = setup();
  const receipt = await open(s);
  await drain(s);
  // The child's thread differs from the root's, yet both used one sandbox.
  expect(fixture.fake.calls.create).toBe(1);
  expect(await binding(s, "alice", receipt.threadId)).toMatchObject({
    sandboxId: "fake-sandbox-1",
  });
  const mainCalls = fixture.calls.filter((entry) => entry.agent === "Main");
  const lastMain = mainCalls[mainCalls.length - 1];
  expect(JSON.stringify(lastMain.args.prompt)).toContain("from child");
});

it("a finished background job becomes a sandbox note delivered at the next safe turn claim", async () => {
  fixture.fake = fakeSandboxProvider({
    background: () => [
      { state: "running" },
      { state: "done", exitCode: 0, logTail: "build finished" },
    ],
  });
  fixture.steps.Main = (n) =>
    n === 0 ? call("sandbox_run_background", { command: "make build" }) : text("started");
  const s = setup();
  const receipt = await open(s);
  await drain(s);
  expect(fixture.fake.calls.background).toEqual(["make build"]);
  expect(fixture.fake.calls.poll).toHaveLength(2);
  // The job is finished and its note is admitted, but an idle thread shows
  // nothing until a new turn claims: notes never wake or rewrite a settled turn.
  expect(await notes(s, "alice", receipt.threadId)).toHaveLength(0);
  const before = fixture.calls.length;
  await send(s, "alice", receipt.threadId, "second");
  await drain(s);
  expect(fixture.calls.length).toBeGreaterThan(before);
  expect(JSON.stringify(fixture.calls[before].args.prompt)).toMatch(
    /Job \S+: done \(exit 0\)\\nbuild finished/,
  );
  const delivered = await notes(s, "alice", receipt.threadId);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ from: "sandbox", role: "user", status: "success" });
  expect(delivered[0].text).toContain("build finished");
  // Poll chain stopped: a delivered job is never polled or announced again.
  await vi.advanceTimersByTimeAsync(LIMITS.pollMaxMs * 4);
  expect(fixture.fake.calls.poll).toHaveLength(2);
});

it("a job completion note carries a bounded log tail and the deadline reason", async () => {
  const flood = `${"x".repeat(LIMITS.outputChars)}LAST-LINE`;
  fixture.fake = fakeSandboxProvider({
    background: () => [{ state: "done", exitCode: 3, logTail: flood }],
  });
  fixture.steps.Main = (n) =>
    n === 0 ? call("sandbox_run_background", { command: "noisy" }) : text("started");
  const s = setup();
  const receipt = await open(s);
  await drain(s);
  await send(s, "alice", receipt.threadId, "second");
  await drain(s);
  const [note] = await notes(s, "alice", receipt.threadId);
  expect(note.text).toContain("(exit 3)");
  expect(note.text.endsWith("LAST-LINE</note>")).toBe(true);
  // Header + at most completionLogChars of log: never the full provider tail.
  expect(note.text.length).toBeLessThan(LIMITS.completionLogChars + 200);
  expect(note.text.length).toBeLessThan(flood.length);
});

it("a second subject cannot reach the first subject's sandbox", async () => {
  fixture.scope = "subject";
  const script = [
    call("sandbox_write_file", { path: "/secret.txt", content: "alice-only" }),
    text("alice done"),
    call("sandbox_read_file", { path: "/secret.txt" }),
    text("bob done"),
  ];
  fixture.steps.Main = () => script.shift()!;
  const s = setup();
  const aliceThread = (await open(s, "alice")).threadId;
  await drain(s);
  const bobThread = (await open(s, "bob", "Main", "bob-first")).threadId;
  await drain(s);

  // Each subject got its own provider sandbox; bob's holds none of alice's files.
  expect(fixture.fake.calls.create).toBe(2);
  const alice = await binding(s, "alice", aliceThread);
  const bob = await binding(s, "bob", bobThread);
  expect(alice!.sandboxId).not.toEqual(bob!.sandboxId);
  expect(fixture.fake.sandboxes.get(alice!.sandboxId!)!.files.has("/secret.txt")).toBe(true);
  expect(fixture.fake.sandboxes.get(bob!.sandboxId!)!.files.size).toBe(0);
  // Bob's model never saw the content: his read hit his own empty sandbox.
  const bobPrompts = JSON.stringify(fixture.calls.slice(2).map((entry) => entry.args.prompt));
  expect(bobPrompts).not.toContain("alice-only");

  // Naming alice's thread does not help either; only alice can export it.
  const before = await s.t.run((ctx) => ctx.db.system.query("_storage").collect());
  await expect(
    as(s, "bob").action(api.agents.exportFile, { threadId: aliceThread, path: "/secret.txt" }),
  ).rejects.toThrow();
  expect(await s.t.run((ctx) => ctx.db.system.query("_storage").collect())).toEqual(before);
  expect(
    await as(s, "alice").action(api.agents.exportFile, {
      threadId: aliceThread,
      path: "/secret.txt",
    }),
  ).toMatchObject({ bytes: "alice-only".length });
});

it("a job started by an opted-in child posts its note to a root agent that has not opted in", async () => {
  fixture.steps.Lead = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "build it" }) : text("lead done");
  fixture.steps.Builder = (n) =>
    n === 0 ? call("sandbox_run_background", { command: "make" }) : text("started");
  const s = setup();
  const receipt = await open(s, "alice", "Lead");
  await drain(s);
  // The root offers no sandbox tools; only the child could start the job.
  expect(offered("Lead")).toEqual([]);
  expect(fixture.fake.calls.background).toEqual(["make"]);
  // The delegation result starts another root turn, a safe claim that delivers it.
  await send(s, "alice", receipt.threadId, "second");
  await drain(s);
  const delivered = await notes(s, "alice", receipt.threadId);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ from: "sandbox", role: "user", status: "success" });
  expect(delivered[0].text).toMatch(/Job \S+: done \(exit 0\)/);
});

it("a deadline-expired job's note starts with the SANDBOX_JOB_DEADLINE reason", async () => {
  fixture.fake = fakeSandboxProvider({ background: () => [{ state: "running" }] });
  fixture.limits = { pollMinMs: 100, pollMaxMs: 400, jobTimeoutMs: 1_000 };
  fixture.steps.Main = (n) =>
    n === 0 ? call("sandbox_run_background", { command: "forever" }) : text("started");
  const s = setup();
  const receipt = await open(s);
  await drain(s);
  await send(s, "alice", receipt.threadId, "second");
  await drain(s);
  const [note] = await notes(s, "alice", receipt.threadId);
  expect(note.text).toMatch(/Job \S+: unknown\n\[SANDBOX_JOB_DEADLINE\]/);
  expect(fixture.fake.calls.cancel).toHaveLength(1);
});
