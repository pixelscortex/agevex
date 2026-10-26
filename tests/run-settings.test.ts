// @vitest-environment edge-runtime
// Section 9's public guarantees, driven through real Workflow and native Agent
// with deterministic fake providers. No provider credentials or network calls.
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import {
  componentsGeneric,
  type FunctionReference,
  type GenericMutationCtx,
  type GenericDataModel,
} from "convex/server";
import { convexTest } from "convex-test";
import native from "@convex-dev/agent/test";
import { mockModel } from "@convex-dev/agent";
import { getConvexSize } from "convex/values";
import { Agent, registerAgent, type RunSettings, type MeterBackend } from "../src/client/index.js";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { fixture, reset, exports, api, registration, text, call } from "./hooks.host.js";
import { components, rawAssignment, internal } from "./fixture/api.js";
import { requireReceipt } from "./receipt.js";
import { RUN_LIMITS, resolveRunSettings, sliceWatchdogMs } from "../src/component/run-settings.js";

const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

function setup() {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: { ...modules, "./fixture/agents.ts": async () => exports() },
  });

  native.register(t);
  agevex.register(t);

  return t;
}
type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });

const open = (t: Test, key = "first") =>
  owner(t)
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: key,
      requestKey: key,
    })
    .then(requireReceipt);

const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);

const transcript = (t: Test, threadId: string) =>
  owner(t).query(api.agents.messages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

const activity = (t: Test, threadId: string) => owner(t).query(api.agents.activity, { threadId });

beforeEach(() => {
  vi.useFakeTimers();
  reset();
  fixture.builderSides = [];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["stream", "generate"] as const)(
  "generate and stream preserve collaboration semantics (%s)",
  async (mode) => {
    const t = setup();
    const usage: unknown[] = [];

    const charge = {
      key: "test",
      attach: async () => {},
      correct: async () => {},
      settle: async () => {},
      get: async () => null,
    };

    const backend: MeterBackend = {
      estimate: async () => charge,
      record: async (_provider, args) => {
        usage.push(args.usage);

        return charge;
      },
    };

    fixture.slots.usage = { scope: () => backend };
    fixture.run = { Main: { mode }, Builder: { mode } };

    fixture.steps.Main = (n) =>
      n === 0 ? call("agevex_delegate", { agent: "Builder", task: "review" }) : text("done");

    fixture.steps.Builder = () => text("reviewed");
    const receipt = await open(t);

    await drain(t);
    const messages = await transcript(t, receipt.threadId);

    expect(messages.page.some((m) => m.text === "done")).toBe(true);
    expect(messages.page.some((m) => m.text?.includes("reviewed"))).toBe(true);
    expect(usage).toHaveLength(3);
    expect(fixture.modes).toEqual([mode, mode, mode]);

    expect(await activity(t, receipt.threadId)).toMatchObject({
      turnStatus: "idle",
      errorCode: null,
    });
  },
);

it.each(["stream", "generate"] as const)(
  "generate and stream preserve approval pauses (%s)",
  async (mode) => {
    const t = setup();

    fixture.run.Main = { mode };
    fixture.approval = true;

    fixture.steps.Main = (n) =>
      n === 0 ? call("echo", { text: "approved effect" }) : text("done");

    const receipt = await open(t);

    await drain(t);
    const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

    const [message] = await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [row!.approvals!.requests[0].messageId],
    });

    const content = message?.message?.content;

    const approval = Array.isArray(content)
      ? content.find((p) => p.type === "tool-approval-request")
      : undefined;

    expect(approval?.type).toBe("tool-approval-request");
    expect(fixture.effects).toEqual([]);

    if (!approval || approval.type !== "tool-approval-request") throw new Error("missing approval");

    await owner(t).mutation(api.agents.respond, {
      threadId: receipt.threadId,
      approvalId: approval.approvalId,
      approved: true,
    });

    await drain(t);
    expect(fixture.effects).toEqual(["approved effect"]);
    expect((await transcript(t, receipt.threadId)).page.some((m) => m.text === "done")).toBe(true);
  },
);

it("settings snapshot survives deploy", async () => {
  const t = setup();

  fixture.run = {
    Main: { mode: "generate", maxOutputTokens: 123 },
    Builder: { mode: "generate", maxOutputTokens: 456 },
  };

  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "review" }) : text("done");

  const receipt = await open(t);

  // The function loader builds a new registration after acceptance, modelling
  // a deploy before the root or its not-yet-created child claims any slices.
  fixture.run = {
    Main: { mode: "stream", maxOutputTokens: 789 },
    Builder: { mode: "stream", maxOutputTokens: 987 },
  };

  await drain(t);
  expect(fixture.modes).toEqual(["generate", "generate", "generate"]);
  expect(fixture.calls.map((c) => c.args.maxOutputTokens)).toEqual([123, 456, 123]);

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "new",
    requestKey: "new",
  });

  await drain(t);
  expect(fixture.modes[fixture.modes.length - 1]).toBe("stream");
  expect(fixture.calls[fixture.calls.length - 1]?.args.maxOutputTokens).toBe(789);
});

it.each([1, 3, 64])(
  "step limit counts slices not hidden model calls (%i)",
  async (stepsPerTurn) => {
    const t = setup();

    fixture.run.Main = { stepsPerTurn };
    fixture.steps.Main = () => call("echo", { text: "step" });
    const receipt = await open(t);

    await drain(t);
    expect(fixture.calls).toHaveLength(stepsPerTurn);
    expect(fixture.effects).toHaveLength(stepsPerTurn);
    expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: "SLICE_LIMIT" });
  },
);

it.each(["stream", "generate"] as const)(
  "timeout never retries an unknown effect (%s)",
  async (mode) => {
    const t = setup();
    let release!: () => void;
    let effects = 0;
    let lateWriteRefused = false;
    let done!: () => void;

    const toolDone = new Promise<void>((resolve) => {
      done = resolve;
    });

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    fixture.run.Main = { mode, modelTimeoutMs: 1_000, toolTimeoutMs: 2_000 };
    fixture.steps.Main = () => call("metered_once", {});

    fixture.toolWork = async (tc) => {
      effects++;
      await held;
      expect(tc.signal.aborted).toBe(true);

      try {
        await tc.ctx.runMutation(components.agevex.hooks.notes.addNote, {
          assignmentId: receipt.assignmentId,
          text: "late",
          from: "tool",
        });
      } catch {
        lateWriteRefused = true;
      }

      done();

      return "late result";
    };

    const receipt = await open(t);

    await drain(t);
    expect(effects).toBe(1);
    expect(fixture.calls).toHaveLength(1);
    expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: "GENERATION_FAILED" });
    release();
    await toolDone;
    await t.finishInProgressScheduledFunctions();
    expect(lateWriteRefused).toBe(true);

    expect(
      (await transcript(t, receipt.threadId)).page.some((m) => m.text?.includes("late result")),
    ).toBe(false);

    expect(
      (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.notesPending,
    ).toBe(0);
  },
);

it.each(["stream", "generate"] as const)(
  "model timeout closes the placeholder without waiting for an uncooperative provider (%s)",
  async (mode) => {
    const t = setup();
    let release!: () => void;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    fixture.run.Main = { mode, modelTimeoutMs: 1_000 };

    fixture.steps.Main = async () => {
      await held;

      return text("late provider response");
    };

    const receipt = await open(t);

    await drain(t);
    expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: "GENERATION_FAILED" });
    release();
    await t.finishInProgressScheduledFunctions();

    expect(
      (await transcript(t, receipt.threadId)).page.some(
        (m) => m.status === "pending" || m.text === "late provider response",
      ),
    ).toBe(false);
  },
);

it("lane overrides respect shared capacity", async () => {
  const t = setup();
  const accepted = await open(t);

  fixture.run.Main = { mode: "generate" };
  expect(() => registration({ rootLane: 5 })).toThrow("INVALID_LIMIT");
  const changed = registration({ rootLane: 1, childLane: 3 }).authorizedEndpoints();

  const handler = (
    changed.open as unknown as {
      _handler: (
        ctx: GenericMutationCtx<GenericDataModel>,
        args: { agent: string; prompt: string; requestKey: string },
      ) => Promise<unknown>;
    }
  )._handler;

  await expect(
    owner(t).mutation((ctx) =>
      handler(ctx, { agent: "Main", prompt: "conflict", requestKey: "conflict" }),
    ),
  ).rejects.toThrow("LANE_CONFIGURATION_CONFLICT");

  await drain(t);
  expect(await activity(t, accepted.threadId)).toMatchObject({ errorCode: null });
});

it.each<RunSettings>([
  { mode: "invalid" as never },
  { maxOutputTokens: null as never },
  { modelTimeoutMs: null as never },
  { toolTimeoutMs: null as never },
  { stepsPerTurn: null as never },
  { maxOutputTokens: 0 },
  { maxOutputTokens: 32_769 },
  { maxOutputTokens: 1.5 },
  { modelTimeoutMs: 999 },
  { modelTimeoutMs: 300_001 },
  { modelTimeoutMs: NaN },
  { toolTimeoutMs: 999 },
  { toolTimeoutMs: Infinity },
  { stepsPerTurn: 0 },
  { stepsPerTurn: 65 },
  { modelTimeoutMs: 300_000, toolTimeoutMs: 300_000 },
])("invalid settings fail at registration before any model spend (%j)", (run) => {
  const agent = new Agent(components.agent, { name: "Bad", languageModel: mockModel(), run });

  expect(() =>
    registerAgent(components.agevex, {
      agents: [agent],
      refs: { runTurn: () => internal.agents.runTurn },
      authorize: async () => ({ subject: "alice" }),
      authorizeExecution: async () => {},
    }),
  ).toThrow();

  expect(fixture.calls).toHaveLength(0);
});

it("the watchdog uses the accepted settings", async () => {
  const t = setup();

  fixture.run.Main = { modelTimeoutMs: 1_000, toolTimeoutMs: 1_000 };
  const receipt = await open(t);

  const claimed = await t.mutation(components.agevex.turns.slices.claim, {
    assignmentId: receipt.assignmentId,
    turnToken: `${receipt.assignmentId}:0`,
  });

  expect(claimed?.settings).toEqual(resolveRunSettings(fixture.run.Main));
  await vi.advanceTimersByTimeAsync(sliceWatchdogMs(resolveRunSettings(fixture.run.Main)) - 1_000);
  expect(await activity(t, receipt.threadId)).toMatchObject({ turnStatus: "running" });
  await vi.advanceTimersByTimeAsync(2_000);
  await t.finishInProgressScheduledFunctions();
  expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: "EXECUTION_AMBIGUOUS" });
});

it.each(["stream", "generate"] as const)(
  "only stream mode publishes native deltas (%s)",
  async (mode) => {
    const t = setup();
    let release!: () => void;
    let started = false;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    fixture.run.Main = { mode };

    fixture.steps.Main = (n) =>
      n === 0 ? [...text("working"), ...call("managed", {})] : text("done");

    fixture.toolWork = async () => {
      started = true;
      await held;

      return "result";
    };

    const receipt = await open(t);

    await expect
      .poll(async () => {
        await t.action(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });

        return started;
      })
      .toBe(true);

    const streams = await owner(t).query(api.agents.streams, {
      threadId: receipt.threadId,
      streamArgs: { kind: "list" },
    });

    expect(streams.streams?.kind === "list" ? streams.streams.messages.length : 0).toBe(
      mode === "generate" ? 0 : 1,
    );

    release();
    await drain(t);

    expect((await transcript(t, receipt.threadId)).page.some((m) => m.text.endsWith("done"))).toBe(
      true,
    );
  },
);

it.each(["stream", "generate"] as const)(
  "sixteen managed tools execute serially within their own deadlines (%s)",
  async (mode) => {
    const t = setup();
    let active = 0;
    let maximum = 0;
    let completed = 0;

    fixture.run.Main = { mode, stepsPerTurn: 1, modelTimeoutMs: 5_000, toolTimeoutMs: 1_000 };
    fixture.steps.Main = () => Array.from({ length: 16 }, () => call("managed", {})).flat();

    fixture.toolWork = async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 600));
      active--;
      completed++;

      return "done";
    };

    const receipt = await open(t);

    await drain(t);
    expect(maximum).toBe(1);
    expect(completed).toBe(16);
    expect(fixture.calls).toHaveLength(1);
    expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: "SLICE_LIMIT" });
  },
);

it("a maximum-size 64-agent snapshot and model map fit the enforced run envelope", async () => {
  const t = setup();

  const settings = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      String(index).padEnd(128, "x"),
      resolveRunSettings(),
    ]),
  );

  const accepted = await t
    .mutation(components.agevex.turns.send.accept, {
      subject: "alice",
      agent: "Main",
      threadId: "metadata-fixture",
      requestKey: "metadata",
      fingerprint: "metadata",
      promptMessageId: "fixture-prompt",
      runTurn: "unused-fixture-handle",
      limits: (await import("../src/component/limits.js")).resolveLimits(),
      models: { Main: "😀".repeat(100), Builder: "x".repeat(93) },
      settings,
    })
    .then(requireReceipt);

  const metadata = await t.query(
    componentsGeneric().agevex.agevexTest.runMetadata as unknown as FunctionReference<
      "query",
      "internal",
      { assignmentId: string },
      { run: import("../src/component/_generated/dataModel.js").Doc<"runs"> }
    >,
    { assignmentId: accepted.assignmentId },
  );

  expect(getConvexSize(metadata.run)).toBeLessThanOrEqual(RUN_LIMITS.metadataBytes);
  expect(metadata.run.settings).toEqual(settings);

  await t.mutation(components.agevex.turns.cancel.cancel, {
    assignmentId: accepted.assignmentId,
    subject: "alice",
  });

  await drain(t);
});

it("oversized whole settings snapshots fail at registration before acceptance", () => {
  const agents = Array.from(
    { length: 64 },
    (_, index) =>
      new Agent(components.agent, {
        name: String(index).padEnd(128, "x"),
        languageModel: mockModel(),
        run: { mode: "generate" },
      }),
  );

  expect(() =>
    registerAgent(components.agevex, {
      agents,
      refs: { runTurn: () => internal.agents.runTurn },
      authorize: async () => ({ subject: "alice" }),
      authorizeExecution: async () => {},
    }),
  ).toThrow("RUN_SETTINGS_TOO_LARGE");
});

it("valid hard output and combined deadline bounds are accepted without extra model calls", async () => {
  const t = setup();

  fixture.run.Main = {
    mode: "generate",
    maxOutputTokens: 32_768,
    modelTimeoutMs: 1_008,
    toolTimeoutMs: 110_562,
    stepsPerTurn: 1,
  };

  const receipt = await open(t);

  await drain(t);
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0].args.maxOutputTokens).toBe(32_768);
  expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: null });
});
