// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getConvexSize } from "convex/values";
import { createFunctionHandle } from "convex/server";
import { listMessages } from "@convex-dev/agent";
import { setup, api, components, state } from "./setup.js";
import { requireReceipt } from "./receipt.js";
import { LIMITS } from "../src/client/index.js";

type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });
const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
const native = (t: Test, threadId: string) =>
  t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    }),
  );
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function pending(t: Test, count = 1) {
  state.deferred = true;
  state.deferredCount = count;
  const receipt = await owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "ask", requestKey: "ask" })
    .then(requireReceipt);
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(await owner(t).query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 1,
  });
  return receipt;
}

it("free-text answer replays its original native result after the deferred call resumes", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await pending(t);
  const answer = await owner(t).mutation(api.agents.answer, {
    threadId: receipt.threadId,
    toolCallId: "question-0",
    text: "Use the green option",
  });
  const [saved] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [answer.messageId],
  });
  expect(saved?.message).toEqual({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "question-0",
        toolName: "askHuman",
        output: { type: "text", value: "Use the green option" },
      },
    ],
  });
  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("Use the green option");
  const before = await native(t, receipt.threadId);
  await expect(
    owner(t).mutation(api.agents.answer, {
      threadId: receipt.threadId,
      toolCallId: "question-0",
      text: "Use the green option",
    }),
  ).resolves.toEqual(answer);
  expect(await native(t, receipt.threadId)).toEqual(before);
  await drain(t);
  expect(state.calls).toHaveLength(2);
});

it("answer rejects changed text with typed KEY_CONFLICT and preserves the original result", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await pending(t);
  const args = { threadId: receipt.threadId, toolCallId: "question-0", text: "original" };
  const result = await owner(t).mutation(api.agents.answer, args);
  await drain(t);
  const before = await native(t, receipt.threadId);
  await expect(
    owner(t).mutation(api.agents.answer, { ...args, text: "changed" }),
  ).rejects.toMatchObject({ data: { code: "KEY_CONFLICT" } });
  await expect(owner(t).mutation(api.agents.answer, args)).resolves.toEqual(result);
  await expect(
    t.withIdentity({ subject: "bob" }).mutation(api.agents.answer, args),
  ).rejects.toThrow("FORBIDDEN");
  expect(await native(t, receipt.threadId)).toEqual(before);
});

it("all sixteen deferred calls must be answered before a continuation, preserving every answer", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await pending(t, LIMITS.approvalsPerPause);
  for (let i = 0; i < LIMITS.approvalsPerPause; i++) {
    await owner(t).mutation(api.agents.answer, {
      threadId: receipt.threadId,
      toolCallId: `question-${i}`,
      text: `answer ${i}`,
    });
    if (i < LIMITS.approvalsPerPause - 1) {
      await drain(t);
      expect(state.calls).toHaveLength(1);
    }
  }
  await drain(t);
  expect(state.calls).toHaveLength(2);
  for (let i = 0; i < LIMITS.approvalsPerPause; i++)
    expect(JSON.stringify(state.calls[1].prompt)).toContain(`answer ${i}`);
});

it("answer authorizes ownership and refuses foreign, unrecorded, and approval calls without native writes", async () => {
  const t = setup();
  const receipt = await pending(t);
  const args = { threadId: receipt.threadId, toolCallId: "question-0", text: "answer" };
  await expect(
    t.withIdentity({ subject: "bob" }).mutation(api.agents.answer, args),
  ).rejects.toThrow("FORBIDDEN");
  const other = await owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "other", requestKey: "other" })
    .then(requireReceipt);
  await expect(
    owner(t).mutation(api.agents.answer, { ...args, threadId: other.threadId }),
  ).rejects.toThrow("TOOL_CALL_NOT_FOUND");
  const before = await native(t, receipt.threadId);
  await expect(
    owner(t).mutation(api.agents.answer, { ...args, toolCallId: "not-recorded" }),
  ).rejects.toThrow("TOOL_CALL_NOT_FOUND");
  await expect(
    owner(t).mutation(api.agents.respond, {
      threadId: receipt.threadId,
      approvalId: "question-0",
      approved: true,
    }),
  ).rejects.toThrow("APPROVAL_NOT_FOUND");
  expect(await native(t, receipt.threadId)).toEqual(before);
});

it("answer text is bounded and invalid text leaves the call pending", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await pending(t);
  for (const text of [" ", "x".repeat(LIMITS.messageLength + 1)])
    await expect(
      owner(t).mutation(api.agents.answer, {
        threadId: receipt.threadId,
        toolCallId: "question-0",
        text,
      }),
    ).rejects.toThrow("INVALID_MESSAGE");
  await owner(t).mutation(api.agents.answer, {
    threadId: receipt.threadId,
    toolCallId: "question-0",
    text: "😀".repeat(LIMITS.messageLength / 2),
  });
  await drain(t);
  expect(state.calls).toHaveLength(2);
});

it("cancel settles only still-open deferred calls and never duplicates an answered result", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await pending(t, LIMITS.approvalsPerPause);
  await owner(t).mutation(api.agents.answer, {
    threadId: receipt.threadId,
    toolCallId: "question-0",
    text: "already answered",
  });
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  await drain(t);
  const results = (await native(t, receipt.threadId)).page.flatMap((doc) =>
    doc.message?.role === "tool" ? doc.message.content : [],
  );
  expect(results).toHaveLength(LIMITS.approvalsPerPause);
  expect(
    results.filter((part) => part.type === "tool-result" && part.toolCallId === "question-0"),
  ).toEqual([
    {
      type: "tool-result",
      toolCallId: "question-0",
      toolName: "askHuman",
      output: { type: "text", value: "already answered" },
    },
  ]);
  expect(
    results.filter(
      (part) => part.type === "tool-result" && part.output?.type === "execution-denied",
    ),
  ).toHaveLength(LIMITS.approvalsPerPause - 1);
  await expect(
    owner(t).mutation(api.agents.answer, {
      threadId: receipt.threadId,
      toolCallId: "question-1",
      text: "late",
    }),
  ).rejects.toThrow("TOOL_CALL_NOT_FOUND");
});

it("a failed native answer save rolls back its result and leaves the recorded call answerable", async () => {
  const t = setup("cleanupSave", undefined, true);
  const receipt = await pending(t);
  state.cleanupFails = true;
  const args = { threadId: receipt.threadId, toolCallId: "question-0", text: "one result" };
  await expect(owner(t).mutation(api.agents.answer, args)).rejects.toThrow(
    "injected cleanup save failure",
  );
  state.cleanupFails = false;
  await owner(t).mutation(api.agents.answer, args);
  await drain(t);
  expect(state.calls).toHaveLength(2);
  const results = (await native(t, receipt.threadId)).page.filter(
    (doc) => doc.message?.role === "tool",
  );
  expect(results).toHaveLength(1);
});

it("deferred overflow commits a bounded failure before saving untracked calls", async () => {
  const t = setup(undefined, undefined, true);
  state.deferred = true;
  state.deferredCount = LIMITS.approvalsPerPause + 1;
  const receipt = await owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "ask", requestKey: "ask" })
    .then(requireReceipt);
  await drain(t);
  expect(await owner(t).query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "APPROVAL_LIMIT",
  });
  expect(
    (await native(t, receipt.threadId)).page.some((doc) =>
      JSON.stringify(doc.message).includes('"toolName":"askHuman"'),
    ),
  ).toBe(false);
});

it("an owned child thread can receive free text and complete its original delegated run", async () => {
  const t = setup(undefined, undefined, true);
  state.delegate = true;
  state.childDeferred = true;
  const receipt = await owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "delegate", requestKey: "delegate" })
    .then(requireReceipt);
  await drain(t);
  const runs = await owner(t).query(api.agents.delegations, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 10 },
  });
  const childThreadId = runs.page[0].childThreadId!;
  await owner(t).mutation(api.agents.answer, {
    threadId: childThreadId,
    toolCallId: "child-question",
    text: "Child may proceed",
  });
  await drain(t);
  const finished = await owner(t).query(api.agents.delegations, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(finished.page[0]).toMatchObject({ status: "completed", deliveryStatus: "accepted" });
  expect(JSON.stringify((await native(t, childThreadId)).page)).toContain("Child may proceed");
});

it("mixed approval and free-text calls resume only after both native protocols are satisfied", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "mixed", requestKey: "mixed" })
    .then(requireReceipt);
  const row = (await t.query(components.agevex.queue.execution, {
    assignmentId: receipt.assignmentId,
  }))!;
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: receipt.assignmentId,
    turnToken: row.turnToken!,
  });
  const handles = await t.run(async () => ({
    handle: await createFunctionHandle(components.agent.messages.addMessages),
    nativeMessages: {
      getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
      finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
    },
  }));
  await t.mutation(components.agevex.queue.write, {
    assignmentId: receipt.assignmentId,
    executionId: row.turnToken!,
    cancellationEpoch: row.cancellationEpoch,
    ...handles,
    deferredTools: ["askHuman"],
    args: {
      threadId: receipt.threadId,
      promptMessageId: row.promptMessageId,
      failPendingSteps: false,
      messages: [
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "echo-mixed",
                toolName: "echo",
                input: { text: "echo" },
              },
              {
                type: "tool-approval-request",
                approvalId: "mixed-approval",
                toolCallId: "echo-mixed",
              },
              {
                type: "tool-call",
                toolCallId: "question-mixed",
                toolName: "askHuman",
                input: { question: "Which?" },
              },
            ],
          },
        },
      ],
    },
  });
  await owner(t).mutation(api.agents.answer, {
    threadId: receipt.threadId,
    toolCallId: "question-mixed",
    text: "Choose green",
  });
  await drain(t);
  expect(state.calls).toHaveLength(0);
  await owner(t).mutation(api.agents.respond, {
    threadId: receipt.threadId,
    approvalId: "mixed-approval",
    approved: false,
  });
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(JSON.stringify(state.calls[0].prompt)).toContain("Choose green");
});

it("answer reads only the exact recorded native message and never discovers calls from history", async () => {
  const t = setup("transcriptReads", undefined, true);
  const receipt = await pending(t);
  state.transcriptReads = 0;
  await owner(t).mutation(api.agents.answer, {
    threadId: receipt.threadId,
    toolCallId: "question-0",
    text: "exact answer",
  });
  expect(state.transcriptReads).toBe(1);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  await drain(t);
});

it("sixteen maximum-size answers to a near-1 MiB call document stay in budget with a full inbox", async () => {
  const t = setup(undefined, { queueLength: 100 }, true);
  // Native saves preserve both parsed input and raw-input metadata.
  // 16*32,500*2 plus the envelope remains just below Convex's 1 MiB document cap.
  state.deferredQuestion = "x".repeat(32_500);
  const receipt = await pending(t, LIMITS.approvalsPerPause);
  const row = (await t.query(components.agevex.queue.execution, {
    assignmentId: receipt.assignmentId,
  }))!;
  const [call] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [row.approvals!.requests[0].messageId],
  });
  expect(getConvexSize(call)).toBeGreaterThan(1010 << 10);
  expect(getConvexSize(call)).toBeLessThan(1 << 20);
  for (let i = 1; i < 100; i++)
    await owner(t).mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "queued",
      requestKey: `queued-${i}`,
    });
  for (let i = 0; i < LIMITS.approvalsPerPause; i++) {
    const metrics = await owner(t).run(async (ctx) => {
      await ctx.runMutation(api.agents.answer, {
        threadId: receipt.threadId,
        toolCallId: `question-${i}`,
        text: "\uffff".repeat(LIMITS.messageLength),
      });
      return ctx.meta.getTransactionMetrics();
    });
    expect(metrics.bytesRead.used).toBeLessThan(13 << 20);
  }
  // Fence before dispatch: this test verifies maximum control-path payloads,
  // not Agent's separately documented unbounded model-context reader.
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  await drain(t);
  expect(state.calls).toHaveLength(1);
});
