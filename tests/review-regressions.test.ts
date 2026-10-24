// @vitest-environment edge-runtime
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { setup, api, components, state } from "./setup.js";
import { workflowCall } from "../src/testing/expect-journal.js";
import { componentsGeneric, type FunctionReference } from "convex/server";
import { listMessages, saveMessage } from "@convex-dev/agent";
import { main } from "./host.js";
import { LIMITS } from "../src/client/index.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
// An action supplies convex-test syscall scope without opening a transaction
// around periodic scheduled mutations that fire while fake time advances.
const tick = (t: ReturnType<typeof setup>, ms: number) =>
  t.action(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 2000);
const open = (t: ReturnType<typeof setup>) =>
  t.withIdentity({ subject: "alice" }).mutation(api.agents.open, {
    agent: "Main",
    prompt: "review regression",
    requestKey: "review",
  });
const activity = (t: ReturnType<typeof setup>, threadId: string) =>
  t.withIdentity({ subject: "alice" }).query(api.agents.activity, { threadId });

it("an idle loop recovers its only lost ping without a replacement send", async () => {
  const t = setup("lostPing");
  const receipt = await open(t);
  await drain(t);
  state.dropPing = true;
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "only lost doorbell",
    requestKey: "lost",
  });
  await tick(t, 100);
  expect(state.calls).toHaveLength(1);
  // No subsequent send or direct event injection may rescue the accepted row.
  await tick(t, 60_000);
  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
  });
});

it.each([
  ["cancel", false],
  ["a stale epoch", false],
  ["cancel", true],
  ["a stale epoch", true],
] as const)(
  "%s refuses new nested actions and mutations with CANCELLED and an aborted signal (native createTool: %s)",
  async (mode, native) => {
    const t = setup();
    state.nestedAfterCancel = true;
    state.nativeNested = native;
    state.nestedGate = new Promise((resolve) => {
      state.nestedRelease = resolve;
    });
    const receipt = await open(t);
    await expect
      .poll(async () => {
        await tick(t, 100);
        return state.nestedStarted;
      })
      .toBe(true);
    await t
      .withIdentity({ subject: "alice" })
      .mutation(api.agents.cancel, { threadId: receipt.threadId });
    // Resume before the polling interval: nested-call admission must read the fence itself.
    state.nestedAfterCancel = false;
    if (mode === "a stale epoch")
      await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
        threadId: receipt.threadId,
        text: "new epoch",
        requestKey: "new-epoch",
      });
    state.nestedRelease!();
    await drain(t);
    expect(state.nestedCalls).toBe(0);
    expect(state.nestedErrors).toHaveLength(2);
    for (const error of state.nestedErrors)
      expect(error).toMatchObject({ data: { code: "CANCELLED" } });
    expect(state.nestedSignals).toEqual([true, true]);
  },
);

it("two healthy slices complete when their combined duration exceeds the slice watchdog", async () => {
  const t = setup();
  state.tools = true;
  state.delayMs = 70_000;
  const receipt = await open(t);
  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(state.calls.every((call) => !call.abortSignal?.aborted)).toBe(true);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it("a child's slice limit frees its slot and delivers one failure alongside sibling results", async () => {
  const t = setup();
  state.delegate = true;
  state.delegateFanout = 2;
  state.childToolSlices = LIMITS.slicesPerTurn * 2;
  const receipt = await open(t);
  await drain(t);
  const alice = t.withIdentity({ subject: "alice" });
  const runs = await alice.query(api.agents.delegations, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(runs.page).toHaveLength(2);
  expect(
    runs.page.filter((run) => run.status === "failed" && run.errorCode === "SLICE_LIMIT"),
  ).toHaveLength(1);
  expect(runs.page.filter((run) => run.status === "completed")).toHaveLength(1);
  expect(runs.page.every((run) => run.deliveryStatus === "accepted")).toBe(true);
  expect(new Set(runs.page.map((run) => run.resultMessageId)).size).toBe(2);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0, history: 2 },
  });
  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("SLICE_LIMIT");
  expect(JSON.stringify(state.calls[1].prompt)).toContain("RESEARCHER deterministic");
  const messages = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    }),
  );
  expect(messages.page.filter((message) => message.agentName === "Researcher")).toHaveLength(2);
});

it("loop rotation leaves no orphaned pings after busy arrivals", async () => {
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  const alice = t.withIdentity({ subject: "alice" });
  for (let i = 0; i < LIMITS.turnsPerLoop; i++) {
    state.gate = new Promise((resolve) => {
      state.release = resolve;
    });
    await alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "turn " + i,
      requestKey: "turn-" + i,
    });
    const before = state.calls.length;
    await expect
      .poll(async () => {
        await tick(t, 100);
        return state.calls.length;
      })
      .toBe(before + 1);
    await alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "busy " + i,
      requestKey: "busy-" + i,
    });
    state.release!();
    state.gate = undefined;
    await drain(t);
  }
  const events = await workflowCall<
    { orphaned: number },
    typeof import("./fixture/schema.js").default
  >(t, "agevex/rootWorkflow", "query", "agevexJournal", "events");
  expect(events.orphaned).toBe(0);
  expect(state.calls).toHaveLength(1 + 2 * LIMITS.turnsPerLoop);
}, 30_000);

it("registration queue limits govern admission before native writes", async () => {
  const t = setup(undefined, {
    queueLength: 1,
    taskLength: 4,
    runLaunches: 1,
    runHops: 2,
    activeChildrenPerRoot: 1,
    slicesPerTurn: 1,
    leaseMs: 25,
    rootLane: 1,
    childLane: 1,
  });
  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });
  const receipt = await open(t);
  await expect
    .poll(async () => {
      await tick(t, 100);
      return state.calls.length;
    })
    .toBe(1);
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "queued",
    requestKey: "queued",
  });
  await expect(
    alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "over limit",
      requestKey: "denied",
    }),
  ).rejects.toThrow("QUEUE_LIMIT");
  state.release!();
  state.gate = undefined;
  await drain(t);
});

it.each([
  [{ runLaunches: 1 }, "RUN_BUDGET"],
  [{ runHops: 1 }, "RUN_BUDGET"],
  [{ activeChildrenPerRoot: 1 }, "ACTIVE_LIMIT"],
  [{ taskLength: 4 }, "TASK_LIMIT"],
] as const)("registration bound %j denies excess delegation with %s", async (limits, code) => {
  const t = setup(undefined, limits);
  state.delegate = true;
  state.delegateFanout = 2;
  const receipt = await open(t);
  await drain(t);
  const messages = await t.withIdentity({ subject: "alice" }).query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(JSON.stringify(messages)).toContain(code);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0 },
  });
});

it("registration slice limits terminate children at the configured bound", async () => {
  const t = setup(undefined, { slicesPerTurn: 2 });
  state.delegate = true;
  state.childToolSlices = 100;
  const receipt = await open(t);
  await drain(t);
  expect(state.offers.filter((offer) => offer.agent === "Researcher")).toHaveLength(2);
  const runs = await t.withIdentity({ subject: "alice" }).query(api.agents.delegations, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(runs.page[0]).toMatchObject({
    status: "failed",
    errorCode: "SLICE_LIMIT",
    deliveryStatus: "accepted",
  });
});

it("registration lease limits expire an in-flight once tool without repeating its effect", async () => {
  const t = setup(undefined, { leaseMs: 25 });
  state.nestedAfterCancel = true;
  state.nestedGate = new Promise((resolve) => {
    state.nestedRelease = resolve;
  });
  const receipt = await open(t);
  await expect
    .poll(async () => {
      await tick(t, 1);
      return state.nestedStarted;
    })
    .toBe(true);
  await tick(t, 26);
  const admission = await t.mutation(components.agevex.ledger.begin, {
    scope: "tool:alice:" + receipt.threadId + ":nested-cancel-probe",
    key: "nested",
    fingerprint: await (await import("../src/client/once.js")).fingerprint({}),
  });
  expect(admission).toEqual({ status: "unknown" });
  state.nestedAfterCancel = false;
  state.nestedRelease!();
  await drain(t);
});

it("registration root lane limits bound concurrent active model slices", async () => {
  const t = setup(undefined, { rootLane: 1 });
  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });
  await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.open, {
    agent: "Main",
    prompt: "second root",
    requestKey: "second-root",
  });
  await expect
    .poll(async () => {
      await tick(t, 100);
      return state.calls.length;
    })
    .toBe(1);
  await tick(t, 1_000);
  expect(state.calls).toHaveLength(1);
  state.release!();
  state.gate = undefined;
  await drain(t);
  expect(state.calls).toHaveLength(2);
});

it("registration child lane limits bound concurrent child slices without blocking their root", async () => {
  const t = setup(undefined, { childLane: 1 });
  state.delegate = true;
  state.delegateFanout = 2;
  state.childGate = new Promise((resolve) => {
    state.childRelease = resolve;
  });
  const receipt = await open(t);
  await expect
    .poll(async () => {
      await tick(t, 100);
      return state.offers.filter((offer) => offer.agent === "Researcher").length;
    })
    .toBe(1);
  await tick(t, 1_000);
  expect(state.offers.filter((offer) => offer.agent === "Researcher")).toHaveLength(1);
  expect(await activity(t, receipt.threadId)).toMatchObject({ turnStatus: "idle" });
  state.childRelease!();
  state.childGate = undefined;
  await drain(t);
  expect(state.offers.filter((offer) => offer.agent === "Researcher")).toHaveLength(2);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0 },
  });
});

it("completed slices ignore stale watchdogs and exclude time between slices", async () => {
  const t = setup();
  const receipt = await open(t);
  const args = { assignmentId: receipt.assignmentId, turnToken: receipt.assignmentId + ":0" };
  const claimed = await t.mutation(components.agevex.queue.claim, { ...args, sliceId: "first" });
  if (!claimed) throw new Error("not claimed");
  await t.mutation(components.agevex.queue.continueTurn, {
    assignmentId: receipt.assignmentId,
    executionId: args.turnToken,
    cancellationEpoch: claimed.cancellationEpoch,
    messageId: claimed.promptMessageId,
  });
  await tick(t, LIMITS.executionWatchdogMs + 1_000);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "running",
    errorCode: null,
  });
  await t.mutation(components.agevex.queue.claim, { ...args, sliceId: "second" });
  const watchdog = (components.agevex.queue as Record<string, unknown>).stalled as Parameters<
    typeof t.mutation
  >[0];
  await t.mutation(watchdog, { ...args, sliceId: "first" });
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "running",
    errorCode: null,
  });
  await t.mutation(components.agevex.queue.finish, { ...args, errorCode: null });
  await drain(t);
});

it("an approval response followed by a fresh send completes the approval-blocked queue", async () => {
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  await t.run((ctx) =>
    saveMessage(ctx, components.agent, {
      threadId: receipt.threadId,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "pending-call",
            toolName: "echo",
            input: { text: "approved" },
          },
          {
            type: "tool-approval-request",
            approvalId: "pending-approval",
            toolCallId: "pending-call",
          },
        ],
      },
    }),
  );
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "must wait",
    requestKey: "waiting",
  });
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(await activity(t, receipt.threadId)).toMatchObject({ queuedMessages: 1 });
  // Native approval responses share the request's order, even when user
  // messages were queued meanwhile. A plain append would create an invalid
  // protocol fixture that the Agent SDK cannot resume from the older prompt.
  const approval = await t.run((ctx) =>
    main.approveToolCall(ctx, {
      threadId: receipt.threadId,
      approvalId: "pending-approval",
    }),
  );
  // Phase 1a leaves approval continuation to the host's native Agent API. Save
  // the approved tool's result before unrelated queued prompts can be generated.
  await t.action(async (ctx) => {
    await main.generateText(
      ctx,
      { threadId: receipt.threadId },
      {
        promptMessageId: approval.messageId,
        stopWhen: () => true,
      },
    );
  });
  const beforeSend = state.calls.length;
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "resume after approval",
    requestKey: "approved",
  });
  await drain(t);
  expect(state.calls).toHaveLength(beforeSend + 2);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    errorCode: null,
  });
});

it("an idle deployment schedules no recovery jobs after its pending wakes are consumed", async () => {
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  const jobs = () =>
    t.query(
      componentsGeneric().agevex.agevexTest.recoveryJobs as unknown as FunctionReference<"query">,
    );
  expect(await jobs()).toEqual({ total: 0, pending: 0 });
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "one wake",
    requestKey: "wake",
  });
  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(await jobs()).toEqual({ total: 1, pending: 1 });
  // Consume one wake, then ring again before its delayed check: the same
  // transactionally armed check must cover the second wake too.
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "another wake",
    requestKey: "another-wake",
  });
  await drain(t);
  expect(state.calls).toHaveLength(3);
  expect(await jobs()).toEqual({ total: 1, pending: 1 });
  await tick(t, LIMITS.reconcileIntervalMs * 2);
  const settled = await jobs();
  expect(settled).toMatchObject({ pending: 0 });
  await tick(t, LIMITS.reconcileIntervalMs * 10);
  expect(await jobs()).toEqual(settled);
});
