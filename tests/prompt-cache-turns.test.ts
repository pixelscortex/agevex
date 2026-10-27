// @vitest-environment edge-runtime
// Real native Agent turns verify cache policy across Workflow continuations.
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { fixture, reset, exports, api, main, builder, text, call } from "./hooks.host.js";
import { components, rawAssignment } from "./fixture/api.js";
import { requireReceipt } from "./receipt.js";
import type { Instructions } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

type NativeOptions = { instructions?: Instructions; providerOptions?: ProviderOptions };
const mainOptions = main.options as unknown as NativeOptions;
const builderOptions = builder.options as unknown as NativeOptions;

const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);
const claude = { provider: "openrouter.chat", modelId: "anthropic/claude-sonnet-4.6" };
const ephemeral = { type: "ephemeral" };
const instructions = "Stable agent instructions. No request IDs or timestamps.";

function setup() {
  const t = convexTest({
    schema,
    modules: {
      ...modules,
      "./fixture/agents.ts": async () => exports(),
    },
  });

  agent.register(t);
  agevex.register(t);

  return t;
}
type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });

const open = (t: Test) =>
  owner(t)
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "first request",
      requestKey: "first",
    })
    .then(requireReceipt);

const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);

const calls = () =>
  fixture.calls.filter((entry) => entry.agent === "Main").map((entry) => entry.args);

type Request = ReturnType<typeof calls>[number];

const prefix = (args: Request) =>
  JSON.stringify({
    tools: args.tools,
    system: args.prompt.filter((message) => message.role === "system"),
  });

const shape = ({ abortSignal: _signal, ...request }: Request) => request;

function expectMarkers(args: Request, provider = "openrouter") {
  expect(args.prompt.filter((message) => message.role === "system")).toEqual([
    {
      role: "system",
      content: instructions,
      providerOptions: { [provider]: { cacheControl: ephemeral } },
    },
  ]);

  if (provider === "openrouter")
    expect(args.providerOptions?.openrouter?.cacheControl).toEqual(ephemeral);
  else {
    const content = args.prompt[args.prompt.length - 1].content;

    expect(Array.isArray(content)).toBe(true);

    if (Array.isArray(content))
      expect(content[content.length - 1].providerOptions?.anthropic?.cacheControl).toEqual(
        ephemeral,
      );

    expect((JSON.stringify(args).match(/"cacheControl"/g) ?? []).length).toBe(2);
  }
}

beforeEach(() => {
  reset();
  vi.useFakeTimers();
  fixture.modelIdentities = { Main: claude, Builder: claude };
  mainOptions.instructions = instructions;
  builderOptions.instructions = instructions;
});

afterEach(() => {
  mainOptions.instructions = undefined;
  mainOptions.providerOptions = undefined;
  builderOptions.instructions = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["stream", "generate"] as const)(
  "OpenRouter Claude %s keeps tools and system byte-identical across steps and turns",
  async (mode) => {
    fixture.run.Main = { mode };
    fixture.steps.Main = (n) => (n === 0 ? call("echo", { text: "echo" }) : text("done"));
    const t = setup();
    const receipt = await open(t);

    await drain(t);

    await owner(t).mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "next",
      requestKey: "next",
    });

    await drain(t);
    expect(calls()).toHaveLength(3);

    for (const args of calls()) {
      expectMarkers(args);
      expect(prefix(args)).toBe(prefix(calls()[0]));
    }
  },
);

it.each(["stream", "generate"] as const)(
  "direct Anthropic %s marks the system and final content part within four breakpoints",
  async (mode) => {
    fixture.run.Main = { mode };
    fixture.modelIdentities.Main = { provider: "anthropic.messages", modelId: "claude-sonnet-4.6" };
    fixture.steps.Main = (n) => (n === 0 ? call("echo", { text: "echo" }) : text("done"));
    const t = setup();

    await open(t);
    await drain(t);
    expect(calls()).toHaveLength(2);
    calls().forEach((args) => expectMarkers(args, "anthropic"));
  },
);

it.each([
  { provider: "openrouter.chat", modelId: "openai/gpt-5" },
  { provider: "mock", modelId: "mock-model" },
  claude,
])(
  "$provider/$modelId retains the disabled baseline exactly when ineligible or opted out",
  async (identity) => {
    fixture.modelIdentities.Main = identity;
    fixture.experimental.claude.cache = false;
    const t = setup();

    await open(t);
    await drain(t);
    const baseline = shape(calls()[0]);

    fixture.calls = [];

    if (identity !== claude) fixture.experimental.claude.cache = true;

    const second = setup();

    await open(second);
    await drain(second);
    expect(calls()).toHaveLength(1);
    expect(shape(calls()[0])).toEqual(baseline);
    expect(JSON.stringify(baseline)).not.toContain("cacheControl");

    if (identity === claude) {
      fixture.experimental.claude.cache = true;
      fixture.calls = [];
      const enabled = setup();

      await open(enabled);
      await drain(enabled);
      expectMarkers(calls()[0]);
    }
  },
);

it("beforeTurn routing from Claude to non-Claude never carries markers to the next step", async () => {
  fixture.modelIdentities.Routed = { provider: "openrouter.chat", modelId: "openai/gpt-5" };
  let steps = 0;

  fixture.hooks.beforeTurn = () => (++steps === 1 ? undefined : { model: "routed" });
  fixture.steps.Main = () => call("echo", { text: "echo" });
  const t = setup();

  await open(t);
  await drain(t);
  expect(fixture.calls).toHaveLength(2);
  expectMarkers(fixture.calls[0].args);
  expect(JSON.stringify(fixture.calls[1].args)).not.toContain("cacheControl");
});

it("approval resumes retain markers and identical tool order", async () => {
  fixture.approval = true;
  fixture.steps.Main = (n) => (n === 0 ? call("echo", { text: "approved" }) : text("done"));
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

  const [request] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [row!.approvals!.requests[0].messageId],
  });

  const content = request!.message!.content;

  const part = Array.isArray(content)
    ? content.find((part) => part.type === "tool-approval-request")
    : undefined;

  if (part?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");

  await owner(t).mutation(api.agents.respond, {
    threadId: receipt.threadId,
    approvalId: part.approvalId,
    decision: { kind: "approve" },
  });

  await drain(t);
  expect(calls()).toHaveLength(2);
  calls().forEach((args) => expectMarkers(args));
  expect(prefix(calls()[1])).toBe(prefix(calls()[0]));
});

it("delegated child turns receive their own Claude markers", async () => {
  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "bounded task" }) : text("done");

  const t = setup();

  await open(t);
  await drain(t);
  const child = fixture.calls.filter((entry) => entry.agent === "Builder");

  expect(child).toHaveLength(1);
  expectMarkers(child[0].args);
});

it("call-level app hints are preserved without any agevex system marker", async () => {
  mainOptions.providerOptions = { openrouter: { cacheControl: ephemeral, user: "app" } };
  const t = setup();

  await open(t);
  await drain(t);
  expect(calls()).toHaveLength(1);
  expect(calls()[0].providerOptions).toEqual(mainOptions.providerOptions);
  expect(calls()[0].prompt[0]).toEqual({ role: "system", content: instructions });
});
