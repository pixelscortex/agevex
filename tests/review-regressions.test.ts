// @vitest-environment edge-runtime
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { setup, api, components, state } from "./setup.js";
import { workflowCall } from "../src/testing/expect-journal.js";
import { componentsGeneric, createFunctionHandle, type FunctionReference } from "convex/server";
import { createThread, listMessages, saveMessage } from "@convex-dev/agent";
import { main, coordinateReference, runTurnReference } from "./host.js";
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
const recoveryJobs = (t: ReturnType<typeof setup>) =>
  t.query(
    componentsGeneric().agevex.agevexTest.recoveryJobs as unknown as FunctionReference<"query">,
  );

it("a lost ping during a 45s completion delay keeps exactly one recovery check armed until work completes", async () => {
  const t = setup("delayedWait");
  const receipt = await open(t);
  const execution = () =>
    t.query(components.agevex.queue.execution, { assignmentId: receipt.assignmentId });
  await expect
    .poll(async () => {
      await tick(t, 100);
      return (await execution())?.loopWaiting;
    })
    .toBe(true);
  expect(state.calls).toHaveLength(1);
  state.dropPing = true;
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "lost before awaitEvent registration",
    requestKey: "delayed-wait",
  });
  const assertArmed = async () => {
    const row = await execution();
    expect(row?.turnStatus).toBe("queued");
    expect(row?.recoveryAt).toBeDefined();
    // In particular, a coalescing flag must never outlive its recovery job.
    expect(row?.pinged).toBe(true);
    expect(await recoveryJobs(t)).toMatchObject({ pending: 1 });
  };
  await assertArmed();
  await tick(t, 31_000);
  expect(state.calls).toHaveLength(1);
  await assertArmed();
  await tick(t, 15_000);
  await assertArmed();
  await tick(t, 60_000);
  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
  });
  expect((await execution())?.pinged).toBe(false);
  expect(await recoveryJobs(t)).toMatchObject({ pending: 0 });
});

it("cancel closes the active pending placeholder behind a full inbox", async () => {
  const t = setup();
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
  const pending = () =>
    t.run((ctx) =>
      listMessages(ctx, components.agent, {
        threadId: receipt.threadId,
        statuses: ["pending"],
        paginationOpts: { cursor: null, numItems: 100 },
      }),
    );
  const placeholder = (await pending()).page;
  expect(placeholder).toHaveLength(1);
  const alice = t.withIdentity({ subject: "alice" });
  for (let i = 0; i < LIMITS.queueLength; i++)
    await alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "queued " + i,
      requestKey: "queued-" + i,
    });
  expect(await activity(t, receipt.threadId)).toMatchObject({ queuedMessages: 20 });
  await alice.mutation(api.agents.cancel, { threadId: receipt.threadId });
  state.release!();
  state.gate = undefined;
  await drain(t);
  expect((await pending()).page).toEqual([]);
  expect(
    await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [placeholder[0]._id],
    }),
  ).toMatchObject([{ status: "failed", error: "CANCELLED" }]);
  expect(state.calls).toHaveLength(1);
});

it("cancel finalizes every page of native pending placeholders", async () => {
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  // Native hosts may have pending messages beyond the managed generation's
  // single placeholder. Cleanup must exhaust the filtered cursor even while
  // finalization removes earlier pages from the pending-status index.
  const placeholders = await t.mutation(components.agent.messages.addMessages, {
    threadId: receipt.threadId,
    failPendingSteps: false,
    messages: Array.from({ length: LIMITS.verificationPage * 2 + 1 }, () => ({
      message: { role: "assistant" as const, content: [] },
      status: "pending" as const,
    })),
  });
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.cancel, {
    threadId: receipt.threadId,
  });
  await drain(t);
  const messages = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: placeholders.messages.map((message) => message._id),
  });
  expect(messages).toHaveLength(LIMITS.verificationPage * 2 + 1);
  expect(
    messages.every((message) => message?.status === "failed" && message.error === "CANCELLED"),
  ).toBe(true);
});

it("cancel commits its fence before bounded cleanup drains 300 large pending messages", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await open(t);
  await drain(t);
  const messageIds: string[] = [];
  // Separate native writes fit the platform's transaction budget individually;
  // their combined 19 MiB cannot be read by a single cancel transaction.
  for (let i = 0; i < 300; i++) {
    const saved = await t.mutation(components.agent.messages.addMessages, {
      threadId: receipt.threadId,
      failPendingSteps: false,
      messages: [
        {
          message: { role: "assistant", content: [{ type: "text", text: "x".repeat(64 << 10) }] },
          status: "pending",
        },
      ],
    });
    messageIds.push(saved.messages[0]._id);
  }
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.cancel, {
    threadId: receipt.threadId,
  });
  expect(
    await t.query(components.agevex.queue.execution, {
      assignmentId: receipt.assignmentId,
    }),
  ).toMatchObject({ cancelled: true, cancellationEpoch: 1 });
  // Cancellation must yield to scheduled transactions before exhausting native
  // cleanup, even though the durable fence is already observable.
  const pending = () =>
    t.run((ctx) =>
      listMessages(ctx, components.agent, {
        threadId: receipt.threadId,
        statuses: ["pending"],
        paginationOpts: { cursor: null, numItems: 1 },
      }),
    );
  expect((await pending()).page).toHaveLength(1);
  await drain(t);
  expect((await pending()).page).toEqual([]);
  for (const messageId of messageIds) {
    expect(
      await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: [messageId],
      }),
    ).toMatchObject([{ status: "failed", error: "CANCELLED" }]);
  }
}, 30_000);

it("cancel cleanup preserves a pending placeholder from a later send", async () => {
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  const old = await t.mutation(components.agent.messages.addMessages, {
    threadId: receipt.threadId,
    failPendingSteps: false,
    messages: Array.from({ length: LIMITS.verificationPage * 2 + 1 }, () => ({
      message: { role: "assistant" as const, content: [] },
      status: "pending" as const,
    })),
  });
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.cancel, { threadId: receipt.threadId });
  expect(
    await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [old.messages[0]._id],
    }),
  ).toMatchObject([{ status: "pending" }]);
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "new epoch",
    requestKey: "after-cleanup-cutoff",
  });
  const turn = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:1` };
  expect(await t.mutation(components.agevex.queue.claim, turn)).not.toBeNull();
  // Drive the native placeholder save for the claimed send directly, before
  // advancing the scheduler. The same clock tick is intentional: timestamp
  // rounding must not let cleanup close a later order's placeholder.
  const fresh = await t.mutation(components.agent.messages.addMessages, {
    threadId: receipt.threadId,
    failPendingSteps: false,
    messages: [{ message: { role: "assistant", content: [] }, status: "pending" }],
  });
  await t.mutation(components.agevex.queue.finish, { ...turn, errorCode: null });
  await drain(t);
  expect(
    await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [fresh.messages[0]._id],
    }),
  ).toMatchObject([{ status: "pending" }]);
  expect(
    (
      await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: old.messages.map((message) => message._id),
      })
    ).every((message) => message?.status === "failed" && message.error === "CANCELLED"),
  ).toBe(true);
});

it.each(["failed", "blocked"] as const)(
  "two %s deliveries with an empty inbox leave no orphaned event after rotation",
  async (deliveryStatus) => {
    const t = setup();
    const receipt = await open(t);
    const root = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:0` };
    expect(await t.mutation(components.agevex.queue.claim, root)).not.toBeNull();
    const deliveries = [];
    // Use real launch, claim and settlement transitions, holding delivery until
    // the root is asleep. No fake-time advance may resume it between deliveries.
    for (let i = 0; i < 2; i++) {
      const delivery = await t.run(async (ctx) => {
        const reserved = await ctx.runMutation(components.agevex.subagents.reserve, {
          ...root,
          toolCallId: "empty-delivery-" + i,
          agent: "Researcher",
          payloadFingerprint: "empty-delivery-" + i,
          coordinateHandle: await createFunctionHandle(coordinateReference()),
          runTurn: await createFunctionHandle(runTurnReference()),
        });
        if (reserved.kind !== "reserved") throw new Error("RESERVATION_FAILED");
        const threadId = await createThread(ctx, components.agent, { userId: "alice" });
        const { messageId } = await saveMessage(ctx, components.agent, {
          threadId,
          prompt: "task",
        });
        await ctx.runMutation(components.agevex.subagents.attach, {
          runId: reserved.runId,
          childThreadId: threadId,
          promptMessageId: messageId,
        });
        const child = await ctx.runQuery(components.agevex.queue.assignment, { threadId });
        if (!child) throw new Error("CHILD_MISSING");
        const turn = { assignmentId: child.assignmentId, turnToken: `${child.assignmentId}:0` };
        const claimed = await ctx.runMutation(components.agevex.queue.claim, turn);
        if (!claimed?.subagent) throw new Error("CHILD_NOT_CLAIMED");
        await ctx.runMutation(components.agevex.subagents.settle, {
          ...turn,
          runId: reserved.runId,
          childResultMessageId: null,
          errorCode: "GENERATION_FAILED",
        });
        await ctx.runMutation(components.agevex.queue.finish, { ...turn, errorCode: null });
        return { runId: reserved.runId, deliveryToken: claimed.subagent.deliveryToken };
      });
      deliveries.push(delivery);
    }
    await t.mutation(components.agevex.queue.finish, { ...root, errorCode: null });
    await drain(t);
    expect(
      await t.query(components.agevex.queue.execution, {
        assignmentId: receipt.assignmentId,
      }),
    ).toMatchObject({ loopWaiting: true, turnStatus: "idle" });
    // Each serial send consumes one waiting iteration and one turn iteration.
    // Stop at the final wait, so surplus doorbells cannot be consumed by another
    // idle iteration before rotation cleans up this workflows journal.
    const sendsBeforeRotation = Math.floor((LIMITS.turnsPerLoop - 1) / 2);
    const send = (i: number) =>
      t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
        threadId: receipt.threadId,
        text: "rotate " + i,
        requestKey: "rotate-" + i,
      });
    for (let i = 0; i < sendsBeforeRotation; i++) {
      await send(i);
      await drain(t);
    }
    const before = await t.query(components.agevex.queue.execution, {
      assignmentId: receipt.assignmentId,
    });
    for (const delivery of deliveries)
      await t.mutation(components.agevex.subagents.deliver, {
        ...delivery,
        deliveryStatus,
        parentMessageId: null,
        errorCode: deliveryStatus === "failed" ? "DELIVERY_FAILED" : "AUTHORIZATION_DENIED",
      });
    await send(sendsBeforeRotation);
    await drain(t);
    expect(
      (
        await t.query(components.agevex.queue.execution, {
          assignmentId: receipt.assignmentId,
        })
      )?.workflowId,
    ).not.toBe(before?.workflowId);
    const events = await workflowCall<
      { orphaned: number },
      typeof import("./fixture/schema.js").default
    >(t, "agevex/rootWorkflow", "query", "agevexJournal", "events");
    expect(events.orphaned).toBe(0);
    expect(state.calls).toHaveLength(sendsBeforeRotation + 1);
  },
  30_000,
);

it("recovery never re-rings an active generation with queued inbox work", async () => {
  const t = setup();
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
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "wait for active generation",
    requestKey: "active",
  });
  // Exercise even a stale detector arriving after the turn was claimed.
  await t.mutation(
    (components.agevex.queue as Record<string, unknown>).reconcile as FunctionReference<"mutation">,
    { assignmentId: receipt.assignmentId },
  );
  await tick(t, LIMITS.reconcileIntervalMs * 2);
  expect(state.calls).toHaveLength(1);
  const row = await t.query(components.agevex.queue.execution, {
    assignmentId: receipt.assignmentId,
  });
  expect(row).toMatchObject({ turnStatus: "running", pinged: false });
  expect(row?.recoveryAt).toBeUndefined();
  expect(await recoveryJobs(t)).toMatchObject({ pending: 0 });
  state.release!();
  state.gate = undefined;
  await drain(t);
  expect(state.calls).toHaveLength(2);
  const events = await workflowCall<
    { total: number },
    typeof import("./fixture/schema.js").default
  >(t, "agevex/rootWorkflow", "query", "agevexJournal", "events");
  // The sole event is the loop's final awaited ping; no early doorbells were
  // sent to a loop executing a child turn.
  expect(events.total).toBe(1);
});

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

it("an idle deployment with an empty inbox schedules no recovery checks", async () => {
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  const settled = await recoveryJobs(t);
  expect(settled).toMatchObject({ pending: 0 });
  await tick(t, LIMITS.reconcileIntervalMs * 10);
  expect(await recoveryJobs(t)).toEqual(settled);
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "one wake",
    requestKey: "wake",
  });
  await drain(t);
  expect(state.calls).toHaveLength(2);
  // Recovery now follows durable inbox ownership: claim cancels its check
  // immediately, instead of leaving a delayed check for an already idle loop.
  const afterWake = await recoveryJobs(t);
  expect(afterWake).toMatchObject({ pending: 0 });
  await tick(t, LIMITS.reconcileIntervalMs * 10);
  expect(await recoveryJobs(t)).toEqual(afterWake);
});

it("consuming the first ping then losing the second keeps one check through coalesced sends", async () => {
  const t = setup("lostPing");
  const receipt = await open(t);
  await drain(t);
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "consumed first ping",
    requestKey: "first-ping",
  });
  await drain(t);
  expect(state.calls).toHaveLength(2);
  state.dropPing = true;
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "lost second ping",
    requestKey: "second-ping",
  });
  const armed = await t.query(components.agevex.queue.execution, {
    assignmentId: receipt.assignmentId,
  });
  expect(armed?.pinged).toBe(true);
  expect(armed?.recoveryAt).toBeDefined();
  for (let i = 0; i < 3; i++) {
    await alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "coalesced " + i,
      requestKey: "coalesced-" + i,
    });
    expect(await recoveryJobs(t)).toMatchObject({ pending: 1 });
    expect(
      (
        await t.query(components.agevex.queue.execution, {
          assignmentId: receipt.assignmentId,
        })
      )?.recoveryAt,
    ).toBe(armed?.recoveryAt);
  }
  await tick(t, LIMITS.reconcileIntervalMs + 1_000);
  await drain(t);
  expect(state.calls).toHaveLength(6);
  expect(await recoveryJobs(t)).toMatchObject({ pending: 0 });
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
  });
});
