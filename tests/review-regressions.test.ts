// @vitest-environment edge-runtime
import { requireReceipt } from "./receipt.js";
import { it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { setup, api, internal, components, state } from "./setup.js";
import { workflowCall } from "../src/testing/expect-journal.js";
import { componentsGeneric, createFunctionHandle, type FunctionReference } from "convex/server";
import { createThread, listMessages, saveMessage } from "@convex-dev/agent";
import { main, coordinateReference, runTurnReference, fixtureRuntime } from "./host.js";
import { HOST_LIMITS } from "../src/component/limits.js";
import { LIMITS } from "../src/client/index.js";

// Avoid expanding upstream Config's full model-id union just to set context.
const modelContext = (
  main as unknown as {
    options: { contextOptions?: { recentMessages: number } };
  }
).options;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  modelContext.contextOptions = undefined;
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
  t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "review regression",
      requestKey: "review",
    })
    .then(requireReceipt);
const activity = (t: ReturnType<typeof setup>, threadId: string) =>
  t.withIdentity({ subject: "alice" }).query(api.agents.activity, { threadId });
const recoveryJobs = (t: ReturnType<typeof setup>) =>
  t.query(
    componentsGeneric().agevex.agevexTest.recoveryJobs as unknown as FunctionReference<"query">,
  );

/** Each pair is valid native history, saved in its own bounded transaction. */
async function largeToolHistory(
  t: ReturnType<typeof setup>,
  threadId: string,
  count: number,
  bytes: number,
  oneOrder = false,
) {
  // A single parallel-call request puts consecutive result documents at the
  // newest order, so the former 20-message verifier exceeds 16 MiB at 900 KiB.
  const batchRequest = oneOrder
    ? await t.run((ctx) =>
        saveMessage(ctx, components.agent, {
          threadId,
          order: "next",
          message: {
            role: "assistant",
            content: Array.from({ length: count }, (_, i) => ({
              type: "tool-call" as const,
              toolCallId: "large-tool-" + i,
              toolName: "echo",
              input: {},
            })),
          },
        }),
      )
    : undefined;
  for (let i = 0; i < count; i++) {
    await t.run(async (ctx) => {
      const toolCallId = "large-tool-" + i;
      const request =
        batchRequest ??
        (await saveMessage(ctx, components.agent, {
          threadId,
          order: "next",
          message: {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId, toolName: "echo", input: {} }],
          },
        }));
      await saveMessage(ctx, components.agent, {
        threadId,
        promptMessageId: request.messageId,
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: "echo",
              output: {
                type: "text",
                value: "x".repeat(bytes),
              },
            },
          ],
        },
      });
    });
  }
}

it("40 large tool results allow a turn to start, block on recorded approval, and resume after its response", async () => {
  const t = setup(undefined, undefined, true);
  // Bound the host's model context separately: upstream defaults to 100 and
  // also has no byte cap. This regression targets our admission/approval guard.
  modelContext.contextOptions = { recentMessages: 10 };
  state.tools = true;
  state.approval = true;
  const receipt = await open(t);
  // These are newer orders than the admitted prompt. The native generation
  // reads its prompt; the old runtime's 100-message guard reads >17 MiB here.
  await largeToolHistory(t, receipt.threadId, 40, 450 << 10);
  await drain(t);
  expect(state.calls).toHaveLength(1);
  const execution = () =>
    t.query(components.agevex.queue.execution, {
      assignmentId: receipt.assignmentId,
    });
  const paused = await execution();
  expect(paused).toMatchObject({ approvalBlocked: true, queuedMessages: 1 });
  expect(paused?.approvals?.requests[0].messageId).toBeTypeOf("string");
  const [request] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [paused!.approvals!.requests[0].messageId],
  });
  const content = request!.message!.content;
  const part = Array.isArray(content)
    ? content.find((part) => part.type === "tool-approval-request")
    : undefined;
  if (part?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "still blocked",
    requestKey: "still-blocked",
  });
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(await execution()).toMatchObject({ approvalBlocked: true, queuedMessages: 2 });
  await alice.mutation(api.agents.respond, {
    threadId: receipt.threadId,
    approvalId: part.approvalId,
    approved: true,
  });
  state.approval = false;
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "resume",
    requestKey: "resume-large-history",
  });
  await drain(t);
  expect(state.calls.length).toBeGreaterThan(1);
  expect(await execution()).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    errorCode: null,
  });
  expect((await execution())?.approvals).toBeUndefined();
});

it("messages serves an oversized page request over large history in bounded pages", async () => {
  // The client picks the page size. Forty 450 KiB tool results are ~18 MiB, so
  // an unclamped request for 1,000 items would exceed the 16 MiB query read
  // limit and fail. The server clamps count and bytes and hands back a cursor.
  const t = setup(undefined, undefined, true);
  const receipt = await open(t);
  await drain(t);
  await largeToolHistory(t, receipt.threadId, 40, 450 << 10);
  const alice = t.withIdentity({ subject: "alice" });
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 0; pages < 20; pages++) {
    const page: { page: unknown[]; isDone: boolean; continueCursor: string } = await alice.query(
      api.agents.messages,
      {
        threadId: receipt.threadId,
        paginationOpts: { cursor, numItems: 1_000 },
      },
    );
    expect(page.page.length).toBeLessThanOrEqual(LIMITS.messagePage);
    for (const message of page.page as { id: string }[]) seen.add(message.id);
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  // Every tool result is reachable through the cursor, one bounded page at a time.
  expect(seen.size).toBeGreaterThanOrEqual(40);
});

it("20 large tool results cannot prevent exact-id child settlement and delivery", async () => {
  const t = setup(undefined, undefined, true);
  state.delegate = true;
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
  const alice = t.withIdentity({ subject: "alice" });
  const runs = () =>
    alice.query(api.agents.delegations, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    });
  const run = (await runs()).page[0];
  await largeToolHistory(t, run.childThreadId!, 20, 900 << 10, true);
  state.childRelease!();
  state.childGate = undefined;
  await drain(t);
  const completed = (await runs()).page[0];
  expect(completed).toMatchObject({
    status: "completed",
    deliveryStatus: "accepted",
    errorCode: null,
  });
  const finalId = await t.query(
    componentsGeneric().agevex.agevexTest
      .childResultMessageId as unknown as FunctionReference<"query">,
    { runId: completed.runId },
  );
  expect(finalId).toBeTypeOf("string");
  const [final] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [finalId],
  });
  expect(final).toMatchObject({
    threadId: run.childThreadId,
    agentName: "Researcher",
    status: "success",
    text: state.childText,
  });
  const messages = await alice.query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(messages.page.some((message) => message.text.includes(state.childText))).toBe(true);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0 },
  });
});

it("purge keeps maximum-size receipt batches below an 8 MiB read budget", async () => {
  const t = setup(undefined, undefined, { bytesRead: 8 << 20 });
  for (let i = 0; i < LIMITS.purgeBatch + 1; i++) {
    const args = { scope: "purge-margin", key: String(i), fingerprint: String(i) };
    const claim = await t.mutation(components.agevex.ledger.begin, args);
    if (claim.status !== "claimed") throw new Error("RECEIPT_NOT_CLAIMED");
    await t.mutation(components.agevex.ledger.complete, {
      scope: args.scope,
      key: args.key,
      claim: claim.claim,
      result: "x".repeat(LIMITS.receiptResultBytes - 8),
    });
  }
  vi.setSystemTime(Date.now() + LIMITS.receiptRetentionMs + 1);
  const purge = componentsGeneric().agevex.ledger.purge as unknown as FunctionReference<"mutation">;
  const count = componentsGeneric().agevex.agevexTest
    .receiptCount as unknown as FunctionReference<"query">;
  expect(await t.query(count)).toBe(LIMITS.purgeBatch + 1);
  await t.mutation(purge, {});
  expect(await t.query(count)).toBe(1);
  await t.mutation(purge, {});
  expect(await t.query(count)).toBe(0);
});

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
  expect(
    (
      await t.query(components.agevex.queue.execution, {
        assignmentId: receipt.assignmentId,
      })
    )?.pendingGeneration,
  ).toMatchObject({
    messageId: placeholder[0]._id,
    epoch: 0,
    executionId: receipt.assignmentId + ":0",
  });
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

// Simulate an action killed after its native save: use the same transactional
// save wrapper as runtime, but leave the placeholder for scheduled cleanup.
async function savePending(
  t: ReturnType<typeof setup>,
  turn: { assignmentId: string; turnToken: string },
  threadId: string,
  epoch = 0,
  text = "",
  order?: number,
) {
  return t.run(async (ctx) => {
    const saved = (await ctx.runMutation(components.agevex.queue.write, {
      assignmentId: turn.assignmentId,
      executionId: turn.turnToken,
      cancellationEpoch: epoch,
      handle: await createFunctionHandle(components.agent.messages.addMessages),
      nativeMessages: {
        getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
        finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
      },
      args: {
        threadId,
        failPendingSteps: false,
        ...(order === undefined ? {} : { order }),
        messages: [
          {
            message: { role: "assistant", content: text ? [{ type: "text", text }] : [] },
            status: "pending",
          },
        ],
      },
    })) as { messages: { _id: string; order: number }[] };
    return saved.messages[0];
  });
}

it("a cancelled execution can only fail its own recorded placeholder before scheduled cleanup", async () => {
  const t = setup();
  const receipt = await open(t);
  const turn = { assignmentId: receipt.assignmentId, turnToken: receipt.assignmentId + ":0" };
  expect(await t.mutation(components.agevex.queue.claim, turn)).not.toBeNull();
  const own = await savePending(t, turn, receipt.threadId);
  const other = await t.mutation(components.agent.messages.addMessages, {
    threadId: receipt.threadId,
    failPendingSteps: false,
    messages: [{ message: { role: "assistant", content: [] }, status: "pending" }],
  });
  const handle = await t.run(() => createFunctionHandle(components.agent.messages.finalizeMessage));
  await t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.cancel, { threadId: receipt.threadId });
  const finalize = (messageId: string, status: "success" | "failed", cancellationEpoch = 0) =>
    t.mutation(components.agevex.queue.write, {
      assignmentId: receipt.assignmentId,
      executionId: turn.turnToken,
      cancellationEpoch,
      handle,
      args: {
        messageId,
        result: status === "failed" ? { status, error: "abortSignal" } : { status },
      },
    });
  await finalize(other.messages[0]._id, "failed");
  await finalize(own._id, "success");
  await finalize(own._id, "failed", 1);
  expect(
    (
      await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: [own._id, other.messages[0]._id],
      })
    ).map((message) => message?.status),
  ).toEqual(["pending", "pending"]);
  await finalize(own._id, "failed");
  expect(
    await t.query(components.agent.messages.getMessagesByIds, { messageIds: [own._id] }),
  ).toMatchObject([{ status: "failed", error: "CANCELLED" }]);
  await drain(t);
  expect(
    await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [other.messages[0]._id],
    }),
  ).toMatchObject([{ status: "pending" }]);
});

it("cancel cleanup leaves a recorded placeholder alone if it is already terminal", async () => {
  const t = setup();
  const receipt = await open(t);
  const turn = { assignmentId: receipt.assignmentId, turnToken: receipt.assignmentId + ":0" };
  expect(await t.mutation(components.agevex.queue.claim, turn)).not.toBeNull();
  const own = await savePending(t, turn, receipt.threadId);
  await t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.cancel, { threadId: receipt.threadId });
  await t.mutation(components.agent.messages.finalizeMessage, {
    messageId: own._id,
    result: { status: "success" },
  });
  await drain(t);
  expect(
    await t.query(components.agent.messages.getMessagesByIds, { messageIds: [own._id] }),
  ).toMatchObject([{ status: "success" }]);
});

it("cancel leaves unrelated native pending placeholders untouched", async () => {
  const t = setup();
  const receipt = await open(t);
  const turn = { assignmentId: receipt.assignmentId, turnToken: receipt.assignmentId + ":0" };
  expect(await t.mutation(components.agevex.queue.claim, turn)).not.toBeNull();
  const managed = await savePending(t, turn, receipt.threadId);
  // Round 4 adaptation: native-only placeholders have no managed owner, so
  // cancellation must leave them alone instead of exhausting transcript pages.
  const unrelated = await t.mutation(components.agent.messages.addMessages, {
    threadId: receipt.threadId,
    failPendingSteps: false,
    messages: Array.from({ length: 41 }, () => ({
      message: { role: "assistant" as const, content: [] },
      status: "pending" as const,
    })),
  });
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.cancel, {
    threadId: receipt.threadId,
  });
  await drain(t);
  expect(
    await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [managed._id],
    }),
  ).toMatchObject([{ status: "failed", error: "CANCELLED" }]);
  const messages = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: unrelated.messages.map((message) => message._id),
  });
  expect(messages.every((message) => message?.status === "pending")).toBe(true);
});

it("cancel commits a full approval-blocked backlog with maximum limits, children and pending placeholders", async () => {
  const limits = Object.fromEntries(
    Object.entries(HOST_LIMITS).map(([key, { max }]) => [key, max]),
  );
  // Verify these really are the largest accepted settings, not just large values.
  // This boundary assertion fails on the previously unbounded registration.
  expect(() => fixtureRuntime(limits)).not.toThrow();
  for (const [key, { max }] of Object.entries(HOST_LIMITS))
    expect(() => fixtureRuntime({ ...limits, [key]: max + 1 })).toThrow(
      `INVALID_LIMITS: ${key} exceeds maximum ${max}`,
    );
  // Half the read/write/byte budgets; convex-test defaults to 32,000 reads,
  // so explicitly enforce half of the stricter requested 8,192-read ceiling.
  const t = setup(undefined, limits, {
    bytesRead: 8 << 20,
    documentsRead: 4_096,
    documentsWritten: 8_000,
  });
  const receipt = await t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "maximal models and backlog",
      requestKey: "max-models",
      models: { Main: "😀".repeat(100), Researcher: "x".repeat(90) },
    })
    .then(requireReceipt);
  const root = { assignmentId: receipt.assignmentId, turnToken: receipt.assignmentId + ":0" };
  expect(await t.mutation(components.agevex.queue.claim, root)).not.toBeNull();
  const turns = [{ ...root, threadId: receipt.threadId }];
  for (let i = 0; i < HOST_LIMITS.activeChildrenPerRoot.max; i++) {
    const child = await t.run(async (ctx) => {
      const reserved = await ctx.runMutation(components.agevex.subagents.reserve, {
        ...root,
        side: i < HOST_LIMITS.sideRunsPerRun.max,
        toolCallId: "large-child-" + i,
        agent: "Researcher",
        payloadFingerprint: "large-child-" + i,
        coordinateHandle: await createFunctionHandle(coordinateReference()),
        runTurn: await createFunctionHandle(runTurnReference()),
      });
      if (reserved.kind !== "reserved") throw new Error("RESERVATION_FAILED");
      const threadId = await createThread(ctx, components.agent, { userId: "alice" });
      const { messageId } = await saveMessage(ctx, components.agent, {
        threadId,
        prompt: "😀".repeat(HOST_LIMITS.taskLength.max / 2),
      });
      await ctx.runMutation(components.agevex.subagents.attach, {
        runId: reserved.runId,
        childThreadId: threadId,
        promptMessageId: messageId,
      });
      const assignment = await ctx.runQuery(components.agevex.queue.assignment, { threadId });
      if (!assignment) throw new Error("CHILD_MISSING");
      return {
        assignmentId: assignment.assignmentId,
        turnToken: assignment.assignmentId + ":0",
        threadId,
      };
    });
    expect(
      await t.mutation(components.agevex.queue.claim, {
        assignmentId: child.assignmentId,
        turnToken: child.turnToken,
      }),
    ).not.toBeNull();
    turns.push(child);
  }
  for (const turn of turns)
    await t.mutation(
      componentsGeneric().agevex.agevexTest.fillHookMetadata as FunctionReference<"mutation">,
      { assignmentId: turn.assignmentId },
    );
  // Round 4 adaptation: size coverage now uses recorded placeholders across
  // affected assignments; transcript-wide native pending rows are not ours.
  const messageIds: string[] = [];
  for (const turn of turns) {
    // Agent stores text both in message.content and its text projection.
    const pending = await savePending(t, turn, turn.threadId, 0, "x".repeat(490 << 10));
    messageIds.push(pending._id);
  }
  // Fill bounded approval metadata on every assignment as well as its tracked
  // placeholder. Large native ids must not inflate the atomic cancel reads.
  const handles = await t.run(async () => ({
    handle: await createFunctionHandle(components.agent.messages.addMessages),
    nativeMessages: {
      getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
      finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
    },
  }));
  for (const turn of turns) {
    await t.mutation(components.agevex.queue.write, {
      assignmentId: turn.assignmentId,
      executionId: turn.turnToken,
      cancellationEpoch: 0,
      ...handles,
      args: {
        threadId: turn.threadId,
        failPendingSteps: false,
        messages: [
          {
            message: {
              role: "assistant",
              content: Array.from({ length: LIMITS.approvalsPerPause }, (_, i) => [
                { type: "tool-call", toolCallId: `call-${i}`, toolName: "echo", input: {} },
                {
                  type: "tool-approval-request",
                  approvalId: "x".repeat(20 << 10) + i,
                  toolCallId: `call-${i}`,
                },
              ]).flat(),
            },
          },
        ],
      },
    });
    const paused = await t.query(components.agevex.queue.execution, {
      assignmentId: turn.assignmentId,
    });
    expect(paused?.approvals?.requests).toHaveLength(LIMITS.approvalsPerPause);
    // The max-size model snapshot and F1 metadata fit the documented 32 KiB
    // assignment allowance, together with all sixteen pause references.
    expect(new TextEncoder().encode(JSON.stringify(paused)).length).toBeLessThan(
      LIMITS.assignmentBytes,
    );
  }
  const alice = t.withIdentity({ subject: "alice" });
  // Independent passive capacity can coexist with every ready-work slot. Use
  // real, maximum-size escaped native notes on all 21 affected assignments;
  // cancel must delete only their small inbox metadata within the same budget.
  const addMessages = await t.run(() =>
    createFunctionHandle(components.agent.messages.addMessages),
  );
  for (const turn of turns)
    for (let i = 0; i < HOST_LIMITS.notesPending.max; i++)
      expect(
        await t.mutation(components.agevex.hooks.addNote, {
          assignmentId: turn.assignmentId,
          text: '"'.repeat(LIMITS.noteLength),
          from: '"'.repeat(LIMITS.requestKeyLength),
          addMessages,
        }),
      ).toBe(true);
  for (let i = 1; i < HOST_LIMITS.queueLength.max; i++) {
    await alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "😀".repeat(LIMITS.messageLength / 2),
      requestKey: "max-backlog-" + i,
    });
  }
  expect(
    await t.query(components.agevex.queue.execution, {
      assignmentId: receipt.assignmentId,
    }),
  ).toMatchObject({ approvalBlocked: true, queuedMessages: HOST_LIMITS.queueLength.max });
  await expect(
    alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "over capacity",
      requestKey: "over-capacity",
    }),
  ).resolves.toEqual({ status: "rejected", code: "QUEUE_FULL" });
  const queuedWork = () =>
    t.query(
      componentsGeneric().agevex.agevexTest.queuedWork as unknown as FunctionReference<"query">,
    );
  const before = await queuedWork();
  expect(before.inbox).toHaveLength(
    HOST_LIMITS.queueLength.max +
      HOST_LIMITS.activeChildrenPerRoot.max +
      turns.length * HOST_LIMITS.notesPending.max,
  );
  expect(before.runs.every((run: { cancelled: boolean }) => !run.cancelled)).toBe(true);
  // Inspect the actual public cancel transaction, including ownership reads.
  const metrics = await alice.run(async (ctx) => {
    await ctx.runMutation(api.agents.cancel, { threadId: receipt.threadId });
    return ctx.meta.getTransactionMetrics();
  });
  expect(metrics.documentsWritten.used).toBeLessThan(8_000);
  expect(metrics.documentsRead.used).toBeLessThan(4_096);
  expect(metrics.bytesRead.used).toBeLessThan(8 << 20);
  const after = await queuedWork();
  expect(after.inbox).toEqual([]);
  expect(after.runs).toHaveLength(before.runs.length);
  expect(after.runs.every((run: { cancelled: boolean }) => run.cancelled)).toBe(true);
  for (const turn of turns)
    expect(
      await t.query(components.agevex.queue.execution, { assignmentId: turn.assignmentId }),
    ).toMatchObject({
      cancelled: true,
      cancellationEpoch: 1,
      queuedMessages: 0,
      notesPending: 0,
      turnStatus: "idle",
    });
  expect(
    await t.query(components.agent.messages.getMessagesByIds, { messageIds: [messageIds[0]] }),
  ).toMatchObject([{ status: "pending" }]);
  await drain(t);
  for (const messageId of messageIds)
    expect(
      await t.query(components.agent.messages.getMessagesByIds, { messageIds: [messageId] }),
    ).toMatchObject([{ status: "failed", error: "CANCELLED" }]);
  for (const turn of turns) {
    const row = await t.query(components.agevex.queue.execution, {
      assignmentId: turn.assignmentId,
    });
    expect(row?.pendingGeneration).toBeUndefined();
  }
  expect(await activity(t, receipt.threadId)).toMatchObject({
    queuedMessages: 0,
    subagents: { active: 0, history: HOST_LIMITS.activeChildrenPerRoot.max },
  });
  expect(state.calls).toHaveLength(0);
  // Fixture construction includes 21 maximal metadata envelopes and native
  // placeholders; the transaction budgets above remain enforced independently.
}, 60_000);

it("cancel cleanup preserves a fresh generation after native deletion reuses order 6", async () => {
  const t = setup();
  const receipt = await open(t);
  const root = { assignmentId: receipt.assignmentId, turnToken: receipt.assignmentId + ":0" };
  expect(await t.mutation(components.agevex.queue.claim, root)).not.toBeNull();
  await t.mutation(components.agent.messages.addMessages, {
    threadId: receipt.threadId,
    order: 5,
    failPendingSteps: false,
    messages: [{ message: { role: "assistant", content: [] }, status: "success" }],
  });
  const old = await savePending(t, root, receipt.threadId, 0, "", 10);
  expect(old.order).toBe(10);
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.cancel, { threadId: receipt.threadId });
  // Round 4 adaptation: exact native ids, rather than an order cutoff, must
  // protect a later send even when deletion lets its order move backwards.
  await t.mutation(components.agent.messages.deleteByOrder, {
    threadId: receipt.threadId,
    startOrder: 6,
    endOrder: 11,
  });
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "new epoch",
    requestKey: "after-native-deletion",
  });
  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    state.modelStarted = resolve;
  });
  // Start the actual generation without advancing scheduled cleanup yet.
  const generation = t.action(internal.agents.runTurn, {
    assignmentId: receipt.assignmentId,
    turnToken: receipt.assignmentId + ":1",
  });
  await Promise.race([
    started,
    generation.then(() => {
      throw new Error("GENERATION_EXITED_BEFORE_MODEL");
    }),
  ]);
  const fresh = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId: receipt.threadId,
      statuses: ["pending"],
      paginationOpts: { cursor: null, numItems: 1 },
    }),
  );
  const freshId = fresh.page[0]._id;
  expect(fresh.page[0].order).toBe(6);
  // Drain just zero-delay jobs while the fresh model remains held open.
  await tick(t, 100);
  expect(
    await t.query(components.agent.messages.getMessagesByIds, { messageIds: [freshId] }),
  ).toMatchObject([{ status: "pending" }]);
  state.release!();
  state.gate = undefined;
  await Promise.all([generation, drain(t)]);
  expect(
    await t.query(components.agent.messages.getMessagesByIds, { messageIds: [freshId] }),
  ).toMatchObject([{ status: "success" }]);
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
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

it("a child's slice limit frees its slot and delivers a failure after an immediately ready sibling result", async () => {
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
  // R1 delivers the ready sibling immediately instead of waiting for the slicing child.
  expect(state.calls).toHaveLength(3);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("RESEARCHER deterministic");
  expect(JSON.stringify(state.calls[1].prompt)).not.toContain("SLICE_LIMIT");
  expect(JSON.stringify(state.calls[2].prompt)).toContain("SLICE_LIMIT");
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
  ).resolves.toEqual({ status: "rejected", code: "QUEUE_FULL" });
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
  await alice
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "second root",
      requestKey: "second-root",
    })
    .then(requireReceipt);
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
  state.tools = true;
  state.approval = true;
  const receipt = await open(t);
  await drain(t);
  const execution = await t.query(components.agevex.queue.execution, {
    assignmentId: receipt.assignmentId,
  });
  const [request] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [execution!.approvals!.requests[0].messageId],
  });
  const content = request!.message!.content;
  const part = Array.isArray(content)
    ? content.find((part) => part.type === "tool-approval-request")
    : undefined;
  if (part?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");
  const alice = t.withIdentity({ subject: "alice" });
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "must wait",
    requestKey: "waiting",
  });
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(await activity(t, receipt.threadId)).toMatchObject({ queuedMessages: 2 });
  await alice.mutation(api.agents.respond, {
    threadId: receipt.threadId,
    approvalId: part.approvalId,
    approved: true,
  });
  await drain(t);
  const beforeSend = state.calls.length;
  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "resume after approval",
    requestKey: "approved",
  });
  await drain(t);
  expect(state.calls).toHaveLength(beforeSend + 1);
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
