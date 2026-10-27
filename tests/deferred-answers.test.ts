// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { getConvexSize } from "convex/values";
import { createFunctionHandle } from "convex/server";
import { listMessages } from "@convex-dev/agent";
import { setup, api, components, rawAssignment, state } from "./setup.js";
import { requireReceipt } from "./receipt.js";
import { LIMITS } from "../src/component/limits.js";

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
    value: "Use the green option",
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
        output: { type: "json", value: "Use the green option" },
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
      value: "Use the green option",
    }),
  ).resolves.toEqual({ ...answer, replayed: true });

  expect(await native(t, receipt.threadId)).toEqual(before);
  await drain(t);
  expect(state.calls).toHaveLength(2);
});

it("answer rejects changed text with typed KEY_CONFLICT and preserves the original result", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await pending(t);
  const args = { threadId: receipt.threadId, toolCallId: "question-0", value: "original" };
  const result = await owner(t).mutation(api.agents.answer, args);

  await drain(t);
  const before = await native(t, receipt.threadId);

  await expect(
    owner(t).mutation(api.agents.answer, { ...args, value: "changed" }),
  ).rejects.toMatchObject({ data: { code: "KEY_CONFLICT" } });

  await expect(owner(t).mutation(api.agents.answer, args)).resolves.toEqual({
    ...result,
    replayed: true,
  });

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
      value: `answer ${i}`,
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
  const args = { threadId: receipt.threadId, toolCallId: "question-0", value: "answer" };

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
      decision: { kind: "approve" as const },
    }),
  ).rejects.toThrow("APPROVAL_NOT_FOUND");

  expect(await native(t, receipt.threadId)).toEqual(before);
});

it("answer text is bounded and invalid text leaves the call pending", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await pending(t);

  for (const text of [" ", "x".repeat(16 << 10)])
    await expect(
      owner(t).mutation(api.agents.answer, {
        threadId: receipt.threadId,
        toolCallId: "question-0",
        value: text,
      }),
    ).rejects.toThrow();

  await owner(t).mutation(api.agents.answer, {
    threadId: receipt.threadId,
    toolCallId: "question-0",
    value: "😀".repeat(4000),
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
    value: "already answered",
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
      output: { type: "json", value: "already answered" },
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
      value: "late",
    }),
  ).rejects.toThrow("TOOL_CALL_NOT_FOUND");
});

it("a failed native answer save rolls back its result and leaves the recorded call answerable", async () => {
  const t = setup("cleanupSave", undefined, true);
  const receipt = await pending(t);

  state.cleanupFails = true;
  const args = { threadId: receipt.threadId, toolCallId: "question-0", value: "one result" };

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

it("deferred tool-call overflow leaves no actionable untracked calls", async () => {
  const t = setup(undefined, undefined, true);

  state.deferred = true;
  state.deferredCount = LIMITS.approvalsPerPause + 1;

  const receipt = await owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "ask", requestKey: "ask" })
    .then(requireReceipt);

  await drain(t);

  expect(await owner(t).query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "GENERATION_FAILED",
  });

  expect(
    (await native(t, receipt.threadId)).page.some(
      (doc) =>
        doc.status === "success" && JSON.stringify(doc.message).includes('"toolName":"askHuman"'),
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
    value: "Child may proceed",
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

  const row = (await t.query(rawAssignment, {
    assignmentId: receipt.assignmentId,
  }))!;

  await t.mutation(components.agevex.turns.slices.claim, {
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

  await t.mutation(components.agevex.turns.slices.write, {
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
    value: "Choose green",
  });

  await drain(t);
  expect(state.calls).toHaveLength(0);

  await owner(t).mutation(api.agents.respond, {
    threadId: receipt.threadId,
    approvalId: "mixed-approval",
    decision: { kind: "reject" as const },
  });

  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(JSON.stringify(state.calls[0].prompt)).toContain("Choose green");
});

it("answer resolves the exact compact proposal without reading native history", async () => {
  const t = setup("transcriptReads", undefined, true);
  const receipt = await pending(t);

  state.transcriptReads = 0;
  state.forbidTranscriptReads = true;

  await owner(t).mutation(api.agents.answer, {
    threadId: receipt.threadId,
    toolCallId: "question-0",
    value: "exact answer",
  });

  expect(state.transcriptReads).toBe(0);
  state.forbidTranscriptReads = false;
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  await drain(t);
});

it("sixteen bounded answers to a large native source stay in budget with a full inbox", async () => {
  const t = setup(undefined, { queueLength: 100 }, true);

  // Sixteen bounded questions may share a native message larger than 16 KiB.
  state.deferredQuestion = "x".repeat(1500);
  const receipt = await pending(t, LIMITS.approvalsPerPause);

  const row = (await t.query(rawAssignment, {
    assignmentId: receipt.assignmentId,
  }))!;

  const [call] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [row.approvals!.requests[0].messageId],
  });

  expect(getConvexSize(call)).toBeGreaterThan(16 << 10);

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
        value: "\uffff".repeat(5000),
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

it("notes during a multi-call deferred-answer pause wait for every committed result and arrive once at the next claim", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await pending(t, LIMITS.approvalsPerPause);

  for (const text of ["paused first", "paused second"])
    await t.mutation(components.agevex.hooks.notes.addNote, {
      assignmentId: receipt.assignmentId,
      text,
      from: "critic",
    });

  for (let i = 0; i < LIMITS.approvalsPerPause; i++) {
    await owner(t).mutation(api.agents.answer, {
      threadId: receipt.threadId,
      toolCallId: "question-" + i,
      value: "answer " + i,
    });

    if (i < LIMITS.approvalsPerPause - 1) {
      await drain(t);
      expect(state.calls).toHaveLength(1);

      expect(
        (await native(t, receipt.threadId)).page.some((message) => message.text?.includes("<note")),
      ).toBe(false);
    }
  }

  await drain(t);
  expect(state.calls).toHaveLength(2);
  const prompt = JSON.stringify(state.calls[1].prompt);

  expect(prompt.match(/paused first/g)).toHaveLength(1);
  expect(prompt.match(/paused second/g)).toHaveLength(1);
  expect(prompt.indexOf("paused first")).toBeLessThan(prompt.indexOf("paused second"));

  const page = (await native(t, receipt.threadId)).page.sort(
    (a, b) => a.order - b.order || a.stepOrder - b.stepOrder,
  );

  const unresolved = new Set<string>();

  for (const doc of page) {
    if (doc.text?.includes("<note")) expect(unresolved.size).toBe(0);

    if (!Array.isArray(doc.message?.content)) continue;

    for (const part of doc.message.content) {
      if (part.type === "tool-call") unresolved.add(part.toolCallId);

      if (part.type === "tool-result") unresolved.delete(part.toolCallId);
    }
  }

  expect(unresolved.size).toBe(0);

  const notes = (
    await owner(t).query(api.agents.messages, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    })
  ).page.filter((message) => message.origin === "note");

  expect(notes).toMatchObject([
    { origin: "note", from: "critic" },
    { origin: "note", from: "critic" },
  ]);

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "later",
    requestKey: "later",
  });

  await drain(t);

  expect(
    (await native(t, receipt.threadId)).page.filter((message) => message.text?.includes("<note")),
  ).toHaveLength(2);

  expect(
    (await owner(t).query(api.agents.activity, { threadId: receipt.threadId })).turnStatus,
  ).toBe("idle");
});
