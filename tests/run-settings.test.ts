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
import { Agent, registerAgent, type RunSettings } from "../src/client/index.js";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { fixture, reset, exports, api, registration, text, call } from "./hooks.host.js";
import { components, rawAssignment, internal } from "./fixture/api.js";
import { requireReceipt } from "./receipt.js";
import { RUN_LIMITS, resolveRunSettings } from "../src/component/run_settings.js";
import { advanceUntil } from "./clock.js";

const SERIAL_TOOL_LIMITS = { count: 16, workMs: 600 } as const;

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

    fixture.slots.usage = {
      record: async (_ctx, event) => {
        usage.push(event.usage);
      },
    };

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
  "approval resumes leave all sixteen new tool calls available (%s)",
  async (mode) => {
    const t = setup();

    fixture.run.Main = { mode };
    fixture.approval = true;

    fixture.steps.Main = (n) =>
      n === 0
        ? Array.from({ length: 16 }, () => call("echo", { text: "approved effect" })).flat()
        : n === 1
          ? Array.from({ length: 16 }, () => call("managed", {})).flat()
          : text("done");

    const execute = vi.fn(async () => "done");

    fixture.toolWork = execute;

    const receipt = await open(t);

    await drain(t);
    const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

    const [message] = await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [row!.approvals!.requests[0].messageId],
    });

    const content = message?.message?.content;

    const approvals = Array.isArray(content)
      ? content.filter((p) => p.type === "tool-approval-request")
      : [];

    expect(approvals).toHaveLength(16);
    expect(fixture.effects).toEqual([]);

    for (const approval of approvals) {
      await owner(t).mutation(api.agents.respond, {
        threadId: receipt.threadId,
        approvalId: approval.approvalId,
        decision: { kind: "approve" as const },
      });
    }

    await drain(t);
    expect(fixture.effects).toEqual(Array(16).fill("approved effect"));
    expect(execute).toHaveBeenCalledTimes(16);
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
  // The 64-step case drives 64 real Workflow slices; give it room on a loaded machine.
  30_000,
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
    fixture.steps.Main = () => call("once_only", {});

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
    expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: "RUN_TIMEOUT" });
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
    expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: "RUN_TIMEOUT" });
    release();
    await t.finishInProgressScheduledFunctions();

    expect(
      (await transcript(t, receipt.threadId)).page.some(
        (m) => m.status === "pending" || m.text === "late provider response",
      ),
    ).toBe(false);
  },
);

it("updated lane registration admits new sends without consulting stale assignment limits", async () => {
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

  const updated = await owner(t).mutation((ctx) =>
    handler(ctx, { agent: "Main", prompt: "conflict", requestKey: "conflict" }),
  );

  expect(updated).toMatchObject({ status: "accepted" });

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
      title: false,
      agents: [agent],
      refs: { runTurn: () => internal.agents.runTurn },
      authorize: async () => ({ subject: "alice" }),
      authorizeExecution: async () => {},
    }),
  ).toThrow();

  expect(fixture.calls).toHaveLength(0);
});

it("claim returns the accepted settings without scheduling a slice alarm", async () => {
  const t = setup();

  fixture.run.Main = { modelTimeoutMs: 1_000, toolTimeoutMs: 1_000 };
  const receipt = await open(t);

  const claimed = await t.mutation(components.agevex.turns.slices.claim, {
    assignmentId: receipt.assignmentId,
    turnToken: `${receipt.assignmentId}:0`,
  });

  expect(claimed?.settings).toEqual(resolveRunSettings(fixture.run.Main));

  const jobs = await t.query(
    componentsGeneric().agevex.agevexTest.scheduledJobs as unknown as FunctionReference<"query">,
    {},
  );

  expect(jobs).toEqual({ total: 0, pending: 0 });
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

    fixture.steps.Main = () =>
      Array.from({ length: SERIAL_TOOL_LIMITS.count }, () => call("managed", {})).flat();

    fixture.toolWork = async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, SERIAL_TOOL_LIMITS.workMs));
      active--;
      completed++;

      return "done";
    };

    const receipt = await open(t);

    // The generic drain pumps the clock while lazy modules are still loading.
    // Start each 600 ms interval only after its tool is ready; freeze time
    // between tools so machine speed cannot spend their 1,000 ms deadlines.
    await advanceUntil(t, () => active === 1);

    for (let tool = 0; tool < SERIAL_TOOL_LIMITS.count; tool++) {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(SERIAL_TOOL_LIMITS.workMs);
      });

      await advanceUntil(
        t,
        () => completed === tool + 1 && (completed === SERIAL_TOOL_LIMITS.count || active === 1),
        0,
      );
    }

    await drain(t);
    expect(maximum).toBe(1);
    expect(completed).toBe(16);
    expect(fixture.calls).toHaveLength(1);
    expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: "SLICE_LIMIT" });
  },
);

it("a 64-agent snapshot and model map fit the enforced run envelope", async () => {
  const t = setup();

  const settings = Array.from({ length: 64 }, (_, index) => ({
    agent: String(index).padEnd(88, "x"),
    settings: resolveRunSettings(),
  }));

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
      title: false,
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
    toolTimeoutMs: 108_000,
    stepsPerTurn: 1,
  };

  const receipt = await open(t);

  await drain(t);
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0].args.maxOutputTokens).toBe(32_768);
  expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: null });
});

it("a send accepts non-ASCII agent names and claims their snapshotted policy", async () => {
  const t = setup();
  const settings = resolveRunSettings({ maxOutputTokens: 123 });

  const receipt = requireReceipt(
    await t.mutation(components.agevex.turns.send.accept, {
      subject: "alice",
      agent: "Rédacteur",
      threadId: "unicode-agent",
      requestKey: "unicode",
      fingerprint: "unicode",
      promptMessageId: "prompt",
      runTurn: "unused",
      limits: (await import("../src/component/limits.js")).resolveLimits(),
      settings: [{ agent: "Rédacteur", settings }],
    }),
  );

  const claimed = await t.mutation(components.agevex.turns.slices.claim, {
    assignmentId: receipt.assignmentId,
    turnToken: receipt.assignmentId + ":0",
  });

  expect(claimed?.agent).toBe("Rédacteur");
  expect(claimed?.settings).toEqual(settings);

  await t.mutation(components.agevex.turns.cancel.cancel, {
    assignmentId: receipt.assignmentId,
    subject: "alice",
  });

  await drain(t);
});

it("a run without settings uses defaults through all slices", async () => {
  const t = setup();

  fixture.steps.Main = (n) => (n === 0 ? call("managed", {}) : text("done"));
  const receipt = await open(t);

  await t.mutation(
    componentsGeneric().agevex.agevexTest
      .fillRunSettings as unknown as FunctionReference<"mutation">,
    {},
  );

  await drain(t);
  expect(fixture.calls).toHaveLength(2);

  expect(
    fixture.calls.every((c) => c.args.maxOutputTokens === RUN_LIMITS.maxOutputTokens.default),
  ).toBe(true);

  expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: null });
});

it.each(["stream", "generate"] as const)(
  "aborted paid steps report partial usage when native evidence is dropped (%s)",
  async (mode) => {
    for (const reason of ["tool timeout", "tool limit", "model timeout", "cancel"]) {
      reset();
      const t = setup();
      let release!: () => void;

      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      fixture.slots.usage = { record: async () => {} };
      fixture.run.Main = { mode, modelTimeoutMs: 1_000, toolTimeoutMs: 1_000 };

      fixture.steps.Main = async () => {
        if (reason === "tool timeout") return call("managed", {});

        if (reason === "tool limit")
          return Array.from({ length: 17 }, () => call("managed", {})).flat();

        await held;

        return text("late answer");
      };

      fixture.toolWork = async () => {
        await held;

        return "late tool";
      };

      const receipt = await open(t);

      await expect
        .poll(async () => {
          await vi.advanceTimersByTimeAsync(100);

          return fixture.calls.length;
        })
        .toBe(1);

      const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });
      const runId = row!.runId!;

      if (reason === "cancel")
        await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

      await drain(t);
      expect(await t.query(components.agevex.turns.slices.usageReporting, { runId })).toBe(true);
      expect(fixture.calls).toHaveLength(1);
      release();
      await t.finishInProgressScheduledFunctions();
    }
  },
);

it("each tool checks its budget once", async () => {
  const t = setup();
  const check = vi.fn(async () => ({ allowed: true }));

  fixture.slots.budget = { check };

  fixture.steps.Main = (n) => (n === 0 ? call("managed", {}) : text("done"));
  const receipt = await open(t);

  await drain(t);
  expect(check).toHaveBeenCalledTimes(3);
  expect(await activity(t, receipt.threadId)).toMatchObject({ errorCode: null });
});
