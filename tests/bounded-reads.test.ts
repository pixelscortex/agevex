// @vitest-environment edge-runtime
import { requireReceipt } from "./receipt.js";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createFunctionHandle, type PaginationResult } from "convex/server";
import { getConvexSize } from "convex/values";
import { listMessages, saveMessage } from "@convex-dev/agent";
import { setup, api, components, rawAssignment, state } from "./setup.js";
import { main } from "./host.js";
import type { ManagedAgent, OriginMessage } from "../src/client/index.js";
import { LIMITS } from "../src/client/index.js";
import { HOST_LIMITS } from "../src/component/limits.js";

type Test = ReturnType<typeof setup>;
beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 2000);
const owner = (t: Test) => t.withIdentity({ subject: "alice" });

const open = (t: Test, key = "bounded-reads") =>
  owner(t)
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "bounded reads",
      requestKey: key,
    })
    .then(requireReceipt);

const execution = (t: Test, assignmentId: string) => t.query(rawAssignment, { assignmentId });

// Test-only inspection of the small native fixtures; runtime never scans history.
const nativePage = (t: Test, threadId: string) =>
  t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 100, maximumBytesRead: 2 << 20 },
    }),
  );

it("one atomic maximum-note claim stays bounded with six near-1 MiB native merge heads", async () => {
  const t = setup(undefined, { notesPending: HOST_LIMITS.notesPending.max }, true);
  const turn = await claimed(t);

  const [anchor] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [turn.promptMessageId],
  });

  for (const status of ["success", "pending", "failed"] as const)
    for (const tool of [false, true]) {
      await t.mutation(components.agent.messages.addMessages, {
        threadId: turn.threadId,
        order: anchor!.order,
        failPendingSteps: false,
        messages: [
          {
            status,
            message: tool
              ? {
                  role: "tool",
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: `large-${status}`,
                      toolName: "echo",
                      output: { type: "text", value: "x".repeat(1020 << 10) },
                    },
                  ],
                }
              : { role: "user", content: "x".repeat(510 << 10) },
          },
        ],
      });
    }

  const handles = await nativeHandles(t);

  for (let n = 0; n < HOST_LIMITS.notesPending.max; n++) {
    await t.mutation(components.agevex.hooks.notes.addNote, {
      assignmentId: turn.assignmentId,
      text: '"'.repeat(LIMITS.noteLength),
      from: '"'.repeat(LIMITS.requestKeyLength),
    });
  }

  // Notes now drain in the next turn claim, never at a tool-step boundary.
  await t.mutation(components.agevex.turns.slices.finish, {
    assignmentId: turn.assignmentId,
    turnToken: turn.executionId,
    errorCode: null,
  });

  await owner(t).mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "claim notes",
    requestKey: "claim notes",
  });

  const next = (await execution(t, turn.assignmentId))!;

  const metrics = await t.run(async (ctx) => {
    expect(
      await ctx.runMutation(components.agevex.turns.slices.claim, {
        assignmentId: turn.assignmentId,
        turnToken: next.turnToken!,
        notes: {
          addMessages: handles.handle,
          getMessages: handles.nativeMessages.getMessages,
          updateMessage: await createFunctionHandle(components.agent.messages.updateMessage),
        },
      }),
    ).not.toBeNull();

    return ctx.meta.getTransactionMetrics();
  });

  expect(metrics.bytesRead.used).toBeLessThan(10 << 20);
  expect(metrics.bytesWritten.used).toBeLessThan(3 << 20);
  expect((await execution(t, turn.assignmentId))?.notesPending).toBe(0);
  let cursor: string | null = null;
  const notes: { order: number; status: string }[] = [];

  do {
    const page: PaginationResult<OriginMessage> = await owner(t).query(api.agents.messages, {
      threadId: turn.threadId,
      paginationOpts: { cursor, numItems: 100 },
    });

    notes.push(...page.page.filter((message) => message.origin === "note"));
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
  expect(notes).toHaveLength(HOST_LIMITS.notesPending.max);

  expect(
    notes.every((message) => message.order === anchor!.order && message.status === "success"),
  ).toBe(true);

  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

it("cancelled note cleanup cannot deliver old payloads or remove notes from a fresh send", async () => {
  const t = setup(undefined, { notesPending: 2 }, true);
  const turn = await claimed(t);
  const handles = await nativeHandles(t);

  const note = (text: string) =>
    t.mutation(components.agevex.hooks.notes.addNote, {
      assignmentId: turn.assignmentId,
      text,
      from: "critic",
    });

  await note("cancelled advice");
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });

  // Fresh admission and draining deliberately precede the old scheduled cleanup.
  await owner(t).mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "fresh send",
    requestKey: "fresh",
  });

  const fresh = (await execution(t, turn.assignmentId))!;

  // Admission precedes the fresh claim so cleanup can race the new epoch.
  await note("fresh advice");

  await t.mutation(components.agevex.turns.slices.claim, {
    assignmentId: turn.assignmentId,
    turnToken: fresh.turnToken!,
    notes: {
      addMessages: handles.handle,
      getMessages: handles.nativeMessages.getMessages,
      updateMessage: await t.run(() =>
        createFunctionHandle(components.agent.messages.updateMessage),
      ),
    },
  });

  await drain(t);

  const page = await owner(t).query(api.agents.messages, {
    threadId: turn.threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

  expect(
    page.page.filter((message) => message.origin === "note").map((message) => message.text),
  ).toEqual(['<note from="critic">fresh advice</note>']);

  expect((await execution(t, turn.assignmentId))?.notesPending).toBe(0);
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

async function claimed(t: Test) {
  const receipt = await open(t);
  const row = (await execution(t, receipt.assignmentId))!;

  await t.mutation(components.agevex.turns.slices.claim, {
    assignmentId: receipt.assignmentId,
    turnToken: row.turnToken!,
  });

  return {
    ...receipt,
    executionId: row.turnToken!,
    cancellationEpoch: row.cancellationEpoch,
    promptMessageId: row.promptMessageId!,
  };
}
async function nativeHandles(t: Test) {
  return t.run(async () => ({
    handle: await createFunctionHandle(components.agent.messages.addMessages),
    nativeMessages: {
      getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
      finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
    },
  }));
}
async function request(t: Test, count = 2, providerExecuted = false, idPrefix = "approval-") {
  const turn = await claimed(t);

  const writeResult = await t.mutation(components.agevex.turns.slices.write, {
    assignmentId: turn.assignmentId,
    executionId: turn.executionId,
    cancellationEpoch: turn.cancellationEpoch,
    ...(await nativeHandles(t)),
    args: {
      threadId: turn.threadId,
      agentName: "Main",
      promptMessageId: turn.promptMessageId,
      failPendingSteps: false,
      messages: [
        {
          message: {
            role: "assistant",
            content: Array.from({ length: count }, (_, i) => [
              {
                type: "tool-call",
                toolCallId: `call-${i}`,
                toolName: "echo",
                input: { text: "approved echo" },
                ...(providerExecuted ? { providerExecuted: true } : {}),
              },
              {
                type: "tool-approval-request",
                approvalId: `${idPrefix}${i}`,
                toolCallId: `call-${i}`,
              },
            ]).flat(),
          },
        },
      ],
    },
  });

  return { ...turn, writeResult };
}

it("a post-save throw leaves the native approval atomically blocked", async () => {
  const t = setup();

  state.approval = true;
  const managed = main as ManagedAgent;
  const original = managed.streamText.bind(managed);

  vi.spyOn(managed, "streamText").mockImplementation(async (...args) => {
    const result = await original(...args);
    const consume = result.consumeStream.bind(result);

    result.consumeStream = async (options) => {
      await consume(options);
      throw new Error("post-save failure");
    };

    return result;
  });

  const receipt = await open(t);

  await drain(t);
  const row = await execution(t, receipt.assignmentId);

  expect(row).toMatchObject({
    approvalBlocked: true,
    turnStatus: "idle",
    errorCode: null,
    queuedMessages: 1,
  });

  expect(row?.approvals?.requests[0].messageId).toBeTypeOf("string");

  const [native] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [row!.approvals!.requests[0].messageId],
  });

  expect(JSON.stringify(native?.message)).toContain("tool-approval-request");

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "wait",
    requestKey: "wait",
  });

  await drain(t);
  expect(state.calls).toHaveLength(1);

  expect(await execution(t, receipt.assignmentId)).toMatchObject({
    approvalBlocked: true,
    queuedMessages: 2,
  });
});

it("an unresolved approval does zero native transcript reads", async () => {
  const t = setup("transcriptReads");

  state.approval = true;
  const receipt = await open(t);

  await drain(t);
  state.transcriptReads = 0;
  state.forbidTranscriptReads = true;

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "wait",
    requestKey: "wait",
  });

  await drain(t);
  expect(state.transcriptReads).toBe(0);
  expect(state.calls).toHaveLength(1);
  expect(await execution(t, receipt.assignmentId)).toMatchObject({ approvalBlocked: true });
});

it("respond resolves two approvals separately and resumes from the final native response", async () => {
  const t = setup();
  const turn = await request(t);

  await drain(t);
  const alice = owner(t);

  await alice.mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "queued later",
    requestKey: "later",
  });

  const first = await alice.mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: "approval-0",
    decision: { kind: "approve" as const },
  });

  await drain(t);
  expect(state.calls).toHaveLength(0);
  expect(await execution(t, turn.assignmentId)).toMatchObject({ approvalBlocked: true });

  await expect(
    alice.mutation(api.agents.respond, {
      threadId: turn.threadId,
      approvalId: "approval-0",
      decision: { kind: "approve" as const },
    }),
  ).resolves.toEqual({ ...first, replayed: true });

  const last = await alice.mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: "approval-1",
    decision: { kind: "reject" as const, reason: "declined" },
  });

  const queued = await execution(t, turn.assignmentId);

  expect(queued).toMatchObject({ approvalBlocked: false, promptMessageId: last.messageId });

  const messages = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [queued!.approvals!.requests[0].messageId, first.messageId, last.messageId],
  });

  expect(new Set(messages.map((m) => m!.order)).size).toBe(1);

  expect(messages[2]?.message).toMatchObject({
    role: "tool",
    content: [{ type: "tool-approval-response", approved: false, reason: "declined" }],
  });

  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[0].prompt)).toContain("approved echo");
  expect(JSON.stringify(state.calls[0].prompt)).toContain("execution-denied");

  expect(await execution(t, turn.assignmentId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    errorCode: null,
  });
});

it.each([true, false])(
  "respond replays its original native result after a %s decision resumes the call",
  async (approved) => {
    const t = setup(undefined, undefined, true);
    const turn = await request(t, 1);

    const args = {
      threadId: turn.threadId,
      approvalId: "approval-0",
      decision: approved
        ? { kind: "approve" as const }
        : { kind: "reject" as const, reason: "original reason" },
    };

    const result = await owner(t).mutation(api.agents.respond, args);

    // A first decision is never a replay; the identical retry below is.
    expect(result.replayed).toBe(false);
    await drain(t);
    const before = await nativePage(t, turn.threadId);
    const calls = state.calls.length;

    await expect(owner(t).mutation(api.agents.respond, args)).resolves.toEqual({
      ...result,
      replayed: true,
    });

    expect(await nativePage(t, turn.threadId)).toEqual(before);
    await drain(t);
    expect(state.calls).toHaveLength(calls);
  },
);

it("an approval-pause note is delivered exactly once at the first safe queued turn claim", async () => {
  const t = setup(undefined, undefined, true);

  state.approval = true;
  const turn = await open(t);

  await drain(t);
  const pause = (await execution(t, turn.assignmentId))!;

  expect(pause).toMatchObject({ approvalBlocked: true });

  const [requestMessage] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [pause.approvals!.requests[0].messageId],
  });

  const approval = Array.isArray(requestMessage?.message?.content)
    ? requestMessage.message.content.find((part) => part.type === "tool-approval-request")
    : undefined;

  expect(approval).toBeDefined();

  await t.mutation(components.agevex.hooks.notes.addNote, {
    assignmentId: turn.assignmentId,
    text: "first safe claim advice",
    from: "critic",
  });

  await owner(t).mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "first safe queued turn",
    requestKey: "first safe queued turn",
  });

  await drain(t);
  expect(state.calls).toHaveLength(1);

  await owner(t).mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: approval!.approvalId,
    decision: { kind: "approve" as const },
  });

  await drain(t);
  expect(state.calls).toHaveLength(3);
  expect(JSON.stringify(state.calls[1].prompt)).not.toContain("first safe claim advice");
  expect(JSON.stringify(state.calls[2].prompt)).toContain("first safe queued turn");
  expect(JSON.stringify(state.calls[2].prompt).match(/first safe claim advice/g)).toHaveLength(1);
  expect(await execution(t, turn.assignmentId)).toMatchObject({ notesPending: 0 });

  const page = (await nativePage(t, turn.threadId)).page.sort(
    (a, b) => a.order - b.order || a.stepOrder - b.stepOrder,
  );

  const resultIndex = page.findIndex(
    (doc) =>
      doc.message?.role === "tool" &&
      doc.message.content.some(
        (part) => part.type === "tool-result" && part.toolCallId === "approval-call-0",
      ),
  );

  const noteIndex = page.findIndex((doc) => doc.text?.includes("first safe claim advice"));

  expect(resultIndex).toBeGreaterThanOrEqual(0);
  expect(noteIndex).toBeGreaterThan(resultIndex);
  expect(noteIndex).toBeLessThan(page.findIndex((doc) => doc.text === "first safe queued turn"));

  await owner(t).mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "later claim",
    requestKey: "later claim",
  });

  await drain(t);
  expect(state.calls).toHaveLength(4);
  expect(JSON.stringify(state.calls[3].prompt).match(/first safe claim advice/g)).toHaveLength(1);

  expect(
    (await nativePage(t, turn.threadId)).page.filter((doc) =>
      doc.text?.includes("first safe claim advice"),
    ),
  ).toHaveLength(1);

  expect(await execution(t, turn.assignmentId)).toMatchObject({ notesPending: 0 });
});

it("respond rejects a changed decision or reason with typed KEY_CONFLICT and preserves the original result", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await request(t, 1);

  const args = {
    threadId: turn.threadId,
    approvalId: "approval-0",
    decision: { kind: "approve" as const },
  };

  const result = await owner(t).mutation(api.agents.respond, args);

  await drain(t);
  const before = await nativePage(t, turn.threadId);

  for (const change of [
    { decision: { kind: "reject" as const } },
    { decision: { kind: "reject" as const, reason: "changed" } },
    { decision: { kind: "reject" as const, reason: "" } },
  ])
    await expect(
      owner(t).mutation(api.agents.respond, { ...args, ...change }),
    ).rejects.toMatchObject({ data: { code: "KEY_CONFLICT" } });

  await expect(owner(t).mutation(api.agents.respond, args)).resolves.toEqual({
    ...result,
    replayed: true,
  });

  await expect(
    t.withIdentity({ subject: "bob" }).mutation(api.agents.respond, args),
  ).rejects.toThrow("FORBIDDEN");

  expect(await nativePage(t, turn.threadId)).toEqual(before);
});

it("respond preserves provider-executed flags and rejects other owners", async () => {
  const t = setup();
  const turn = await request(t, 1, true);

  const decision = {
    threadId: turn.threadId,
    approvalId: "approval-0",
    decision: { kind: "reject" as const },
  };

  await expect(
    t.withIdentity({ subject: "bob" }).mutation(api.agents.respond, decision),
  ).rejects.toThrow("FORBIDDEN");

  const response = await owner(t).mutation(api.agents.respond, decision);

  const [native] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [response.messageId],
  });

  expect(native?.message).toMatchObject({
    role: "tool",
    content: [{ type: "tool-approval-response", providerExecuted: true }],
  });

  await drain(t);
});

it("respond authorizes an owned child and continues its managed settlement", async () => {
  const t = setup();

  state.delegate = true;
  state.delegateTask = "keep slicing";
  state.childApproval = true;
  const root = await open(t);

  await drain(t);

  const runs = await owner(t).query(api.agents.delegations, {
    threadId: root.threadId,
    paginationOpts: { cursor: null, numItems: 10 },
  });

  const childThreadId = runs.page[0].childThreadId!;

  const assignment = await t.query(components.agevex.turns.send.assignment, {
    threadId: childThreadId,
  });

  expect(assignment).toMatchObject({ root: false, subject: "alice" });
  const child = (await execution(t, assignment!.assignmentId))!;

  expect(child.approvalBlocked).toBe(true);

  const [message] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [child.approvals!.requests[0].messageId],
  });

  const content = message!.message!.content;

  const part = Array.isArray(content)
    ? content.find((p) => p.type === "tool-approval-request")
    : undefined;

  if (part?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");

  const decision = {
    threadId: childThreadId,
    approvalId: part.approvalId,
    decision: { kind: "reject" as const },
  };

  await expect(
    t.withIdentity({ subject: "bob" }).mutation(api.agents.respond, decision),
  ).rejects.toThrow("FORBIDDEN");

  await owner(t).mutation(api.agents.respond, decision);
  await drain(t);

  const settled = await owner(t).query(api.agents.delegations, {
    threadId: root.threadId,
    paginationOpts: { cursor: null, numItems: 10 },
  });

  expect(settled.page[0]).toMatchObject({
    status: "completed",
    deliveryStatus: "accepted",
    errorCode: null,
  });

  expect(await execution(t, child._id)).toMatchObject({
    turnStatus: "idle",
    approvalBlocked: false,
    queuedMessages: 0,
  });
});

it("sixteen approvals stay bounded and resolve atomically at the pause limit", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await request(t, LIMITS.approvalsPerPause);
  const paused = (await execution(t, turn.assignmentId))!;

  expect(paused.approvals?.requests).toHaveLength(LIMITS.approvalsPerPause);
  expect(new TextEncoder().encode(JSON.stringify(paused.approvals)).length).toBeLessThan(4 << 10);

  for (let i = 0; i < LIMITS.approvalsPerPause; i++) {
    const response = await owner(t).mutation(api.agents.respond, {
      threadId: turn.threadId,
      approvalId: `approval-${i}`,
      decision: { kind: "reject" as const },
    });

    const row = (await execution(t, turn.assignmentId))!;

    expect(row.approvals?.requests.filter((request) => request.resolved)).toHaveLength(i + 1);
    expect(row.approvalBlocked).toBe(i < LIMITS.approvalsPerPause - 1);

    if (i === LIMITS.approvalsPerPause - 1) expect(row.promptMessageId).toBe(response.messageId);
  }

  await drain(t);
});

it("an oversized approval step commits APPROVAL_LIMIT before the native save and never resumes", async () => {
  const t = setup("transcriptReads");
  const turn = await request(t, LIMITS.approvalsPerPause + 1);
  const row = (await execution(t, turn.assignmentId))!;

  expect(row).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "APPROVAL_LIMIT",
  });

  expect(row.approvals).toBeUndefined();
  expect(row.turnToken).toBeUndefined();
  expect(row.watchdogId).toBeUndefined();
  expect(row.recoveryJobId).toBeUndefined();
  expect(turn.writeResult).toBeNull();

  // An action's later failure cannot overwrite the transaction's typed failure.
  await t.mutation(components.agevex.turns.slices.finish, {
    assignmentId: turn.assignmentId,
    turnToken: turn.executionId,
    errorCode: "GENERATION_FAILED",
  });

  state.transcriptReads = 0;
  state.forbidTranscriptReads = true;

  await expect(
    owner(t).mutation(api.agents.send, {
      threadId: turn.threadId,
      text: "must stay blocked",
      requestKey: "overflow-followup",
    }),
  ).resolves.toEqual({ status: "rejected", code: "RECOVERY_REQUIRED" });

  await drain(t);
  expect(state.transcriptReads).toBe(0);
  expect(state.calls).toHaveLength(0);
  expect(await execution(t, turn.assignmentId)).toMatchObject({ errorCode: "APPROVAL_LIMIT" });
});

it.each([1, LIMITS.approvalsPerPause])(
  "%i genuine managed approvals can pause, cancel, and complete a fresh send after native cleanup",
  async (count) => {
    const t = setup(undefined, undefined, true);

    state.approval = true;
    state.approvalCount = count;
    const receipt = await open(t);

    await drain(t);
    const paused = (await execution(t, receipt.assignmentId))!;

    expect(paused).toMatchObject({ approvalBlocked: true, turnStatus: "idle" });
    const approvals = paused.approvals!;

    const [request] = await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [approvals.requests[0].messageId],
    });

    const content = request!.message!.content;

    const approval = Array.isArray(content)
      ? content.find((part) => part.type === "tool-approval-request")
      : undefined;

    if (approval?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");

    await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

    await owner(t).mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "fresh turn",
      requestKey: "fresh-after-cancel",
    });

    expect(await execution(t, receipt.assignmentId)).toMatchObject({
      approvalBlocked: true,
      turnStatus: "idle",
      queuedMessages: 1,
      approvals: { cleanupPending: true },
    });

    await expect(
      owner(t).mutation(api.agents.respond, {
        threadId: receipt.threadId,
        approvalId: approval.approvalId,
        decision: { kind: "approve" as const },
      }),
    ).rejects.toThrow("APPROVAL_NOT_FOUND");

    expect(state.calls).toHaveLength(1);
    await drain(t);
    expect(state.calls).toHaveLength(2);
    expect(JSON.stringify(state.calls[1].prompt)).toContain("execution-denied");
    expect(JSON.stringify(state.calls[1].prompt)).toContain("cancelled");

    expect(await execution(t, receipt.assignmentId)).toMatchObject({
      approvalBlocked: false,
      turnStatus: "idle",
      queuedMessages: 0,
      errorCode: null,
    });

    expect((await execution(t, receipt.assignmentId))?.approvals).toBeUndefined();
  },
);

it("a model tool-call overflow can cancel and complete a fresh send without orphan approvals", async () => {
  const t = setup(undefined, undefined, true);

  state.approval = true;
  state.approvalCount = LIMITS.approvalsPerPause + 1;
  const receipt = await open(t);

  await drain(t);

  expect(await execution(t, receipt.assignmentId)).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "GENERATION_FAILED",
  });

  expect((await execution(t, receipt.assignmentId))?.approvals).toBeUndefined();
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "fresh after overflow",
    requestKey: "fresh-after-overflow",
  });

  await drain(t);
  expect(state.calls).toHaveLength(2);

  expect(await execution(t, receipt.assignmentId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    errorCode: null,
  });

  expect(JSON.stringify(state.calls[1].prompt)).not.toContain("tool-approval-request");
});

it("cancel settles the remaining approvals after a partial response without replaying decisions", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await request(t);

  await owner(t).mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: "approval-0",
    decision: { kind: "approve" as const },
  });

  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });

  await owner(t).mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "fresh",
    requestKey: "fresh-after-partial",
  });

  await drain(t);
  expect(state.calls).toHaveLength(1);

  expect(await execution(t, turn.assignmentId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it("cancel denies only the undecided calls even when the decided approval is last in the pause", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await request(t, 3);

  await owner(t).mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: "approval-2",
    decision: { kind: "approve" as const },
  });

  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);

  // Cleanup retires the recorded requests one per transaction from the front;
  // the decision on the last one must survive the two removals before it.
  const responses = (await nativePage(t, turn.threadId)).page.flatMap((message) =>
    message.message?.role === "tool" && Array.isArray(message.message.content)
      ? message.message.content.filter((part) => part.type === "tool-approval-response")
      : [],
  );

  expect(
    responses.map((part) => [part.approvalId, part.approved, part.reason ?? null]).sort(),
  ).toEqual([
    ["approval-0", false, "cancelled"],
    ["approval-1", false, "cancelled"],
    ["approval-2", true, null],
  ]);

  expect((await execution(t, turn.assignmentId))?.approvals).toBeUndefined();
});

it("pause approve running tool cancel fresh send completes without missing or duplicate results", async () => {
  const t = setup(undefined, undefined, true);

  state.approval = true;
  let release!: () => void;

  state.echoGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const turn = await open(t);

  await drain(t);
  const paused = (await execution(t, turn.assignmentId))!;

  const [native] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [paused.approvals!.requests[0].messageId],
  });

  const content = native!.message!.content;

  const approval = Array.isArray(content)
    ? content.find((part) => part.type === "tool-approval-request")
    : undefined;

  if (approval?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");

  await owner(t).mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: approval.approvalId,
    decision: { kind: "approve" as const },
  });

  expect(await execution(t, turn.assignmentId)).toMatchObject({
    turnStatus: "queued",
    approvals: { requests: [{ resolved: true }] },
  });

  await expect
    .poll(async () => {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      return state.echoStarted;
    })
    .toBe(true);

  expect(await execution(t, turn.assignmentId)).toMatchObject({
    turnStatus: "running",
    approvals: { requests: [{ resolved: true }] },
  });

  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });

  await owner(t).mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "fresh after running tool",
    requestKey: "fresh-running",
  });

  state.echoGate = undefined;
  release();
  await drain(t);

  expect(await execution(t, turn.assignmentId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    queuedMessages: 0,
    approvalBlocked: false,
  });

  expect((await execution(t, turn.assignmentId))?.approvals).toBeUndefined();
  const prompt = JSON.stringify(state.calls[state.calls.length - 1].prompt);

  expect(prompt).toContain("fresh after running tool");
  expect(prompt).toContain("execution-denied");
  expect(prompt.match(/"type":"tool-result"/g)).toHaveLength(1);
  const saved = JSON.stringify((await nativePage(t, turn.threadId)).page);

  expect(saved.match(/"type":"tool-approval-response"/g)).toHaveLength(1);
  expect(saved.match(/"type":"tool-result"/g)).toHaveLength(1);
});

it("cancel after one native tool result commits settles only the remaining exact call", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await request(t);

  for (let i = 0; i < 2; i++)
    await owner(t).mutation(api.agents.respond, {
      threadId: turn.threadId,
      approvalId: `approval-${i}`,
      decision: { kind: "approve" as const },
    });

  const row = (await execution(t, turn.assignmentId))!;

  await t.mutation(components.agevex.turns.slices.claim, {
    assignmentId: turn.assignmentId,
    turnToken: row.turnToken!,
  });

  await t.mutation(components.agevex.turns.slices.write, {
    assignmentId: turn.assignmentId,
    executionId: row.turnToken!,
    cancellationEpoch: row.cancellationEpoch,
    ...(await nativeHandles(t)),
    args: {
      threadId: turn.threadId,
      promptMessageId: row.promptMessageId!,
      failPendingSteps: false,
      messages: [
        {
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-0",
                toolName: "echo",
                output: { type: "text", value: "already committed" },
              },
            ],
          },
        },
      ],
    },
  });

  expect((await execution(t, turn.assignmentId))?.approvals?.requests).toHaveLength(1);
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });

  await owner(t).mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "fresh",
    requestKey: "fresh-partial-result",
  });

  await drain(t);

  expect(await execution(t, turn.assignmentId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    queuedMessages: 0,
  });

  const prompt = JSON.stringify(state.calls[0].prompt);

  expect(prompt.match(/"type":"tool-result"/g)).toHaveLength(2);
  expect(prompt.match(/execution-denied/g)).toHaveLength(1);
  expect(prompt).toContain("already committed");
});

it("near 1 MiB approval request cancels as bounded native pairs and completes a fresh send", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await request(t, LIMITS.approvalsPerPause, false, "x".repeat(65_350));
  const paused = (await execution(t, turn.assignmentId))!;

  const [native] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [paused.approvals!.requests[0].messageId],
  });

  expect(getConvexSize(native)).toBeGreaterThan(1010 << 10);
  expect(getConvexSize(native)).toBeLessThan(1 << 20);
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });

  await owner(t).mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "fresh",
    requestKey: "fresh-huge-request",
  });

  await drain(t);

  expect(await execution(t, turn.assignmentId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    approvalBlocked: false,
    queuedMessages: 0,
  });

  expect((await execution(t, turn.assignmentId))?.approvals).toBeUndefined();
  expect(state.calls).toHaveLength(1);
  const prompt = JSON.stringify(state.calls[0].prompt);

  expect(prompt.match(/"type":"tool-result"/g)).toHaveLength(LIMITS.approvalsPerPause);

  const cleanup = (await nativePage(t, turn.threadId)).page.filter(
    (message) => message.message?.role === "tool",
  );

  expect(cleanup).toHaveLength(LIMITS.approvalsPerPause);

  // The former single native message really would breach Convex's doc limit.
  expect(
    getConvexSize({
      ...cleanup[0],
      message: {
        role: "tool",
        content: cleanup.flatMap((doc) =>
          doc.message?.role === "tool" ? doc.message.content : [],
        ),
      },
    }),
  ).toBeGreaterThan(1 << 20);

  for (const message of cleanup) {
    expect(getConvexSize(message)).toBeLessThanOrEqual(LIMITS.cleanupMessageBytes);

    expect(message.message?.content).toMatchObject([
      { type: "tool-approval-response", approved: false, reason: "cancelled" },
      { type: "tool-result", output: { type: "execution-denied", reason: "cancelled" } },
    ]);
  }
});

it("cleanup failure publishes CLEANUP_FAILED and a later cancel retries without duplicate decisions", async () => {
  const t = setup("cleanupSave", undefined, true);
  const turn = await request(t, 1);

  state.cleanupFails = true;
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);

  expect(await owner(t).query(api.agents.activity, { threadId: turn.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "CLEANUP_FAILED",
  });

  expect((await execution(t, turn.assignmentId))?.approvals).toMatchObject({
    cleanupPending: false,
  });

  state.cleanupFails = false;
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });

  await owner(t).mutation(api.agents.send, {
    threadId: turn.threadId,
    text: "retry",
    requestKey: "cleanup-retry",
  });

  await drain(t);

  expect(await execution(t, turn.assignmentId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    queuedMessages: 0,
    approvalBlocked: false,
  });

  const prompt = JSON.stringify(state.calls[0].prompt);

  expect(prompt.match(/"type":"tool-result"/g)).toHaveLength(1);
  const saved = JSON.stringify((await nativePage(t, turn.threadId)).page);

  expect(saved.match(/"type":"tool-approval-response"/g)).toHaveLength(1);
});

it("huge native approval ids leave fixed-size assignment metadata and still resolve", async () => {
  const t = setup(undefined, undefined, true);
  const prefix = "x".repeat(450 << 10);
  const turn = await request(t, 1, true, prefix);
  const row = (await execution(t, turn.assignmentId))!;

  expect(row.approvals?.requests[0].key).toHaveLength(64);
  expect(JSON.stringify(row.approvals).length).toBeLessThan(4 << 10);

  await owner(t).mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: prefix + "0",
    decision: { kind: "reject" as const },
  });

  expect(await execution(t, turn.assignmentId)).toMatchObject({ approvalBlocked: false });
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

async function activeStream(t: Test, bytes = 450 << 10) {
  const turn = await claimed(t);

  await t.mutation(components.agevex.turns.slices.write, {
    assignmentId: turn.assignmentId,
    executionId: turn.executionId,
    cancellationEpoch: 0,
    ...(await nativeHandles(t)),
    args: {
      threadId: turn.threadId,
      failPendingSteps: false,
      messages: [{ message: { role: "assistant", content: [] }, status: "pending" }],
    },
  });

  const handles = await t.run(async () => ({
    handle: await createFunctionHandle(components.agent.streams.create),
    nativeStream: await createFunctionHandle(components.agent.streams.abort),
  }));

  const streamId = (await t.mutation(components.agevex.turns.slices.write, {
    assignmentId: turn.assignmentId,
    executionId: turn.executionId,
    cancellationEpoch: 0,
    ...handles,
    args: {
      threadId: turn.threadId,
      order: 1,
      stepOrder: 0,
      format: "UIMessageChunk",
      providerOptions: { huge: { value: "x".repeat(bytes) } },
    },
  })) as string;

  return { ...turn, streamId };
}

// Agent owns the 100-document streaming metadata bound; accepted by spec §9b.
it("kind list preserves Agent's 100-stream bound and startOrder", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await activeStream(t, 0);

  for (let i = 0; i < 104; i++)
    await t.mutation(components.agent.streams.create, {
      threadId: turn.threadId,
      order: i + 2,
      stepOrder: 0,
    });

  const read = (startOrder?: number) =>
    owner(t).query(api.agents.streams, {
      threadId: turn.threadId,

      streamArgs: { kind: "list", ...(startOrder !== undefined ? { startOrder } : {}) },
    });

  const result = await read();

  if (result.streams?.kind !== "list") throw new Error("EXPECTED_LIST");

  expect(result.streams.messages).toHaveLength(100);
  expect(result.streams.messages[0].order).toBe(105);
  const filtered = await read(103);

  if (filtered.streams?.kind !== "list") throw new Error("EXPECTED_LIST");

  expect(filtered.streams.messages.map((message) => message.order)).toEqual([105, 104, 103]);
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

it("40 repeated delta cursors read one owned stream within the metadata and delta budget", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await activeStream(t);

  const result = await owner(t).query(api.agents.streams, {
    threadId: turn.threadId,

    streamArgs: {
      kind: "deltas",
      cursors: Array.from({ length: 40 }, () => ({ streamId: turn.streamId, cursor: 0 })),
    },
  });

  if (result.streams?.kind !== "deltas") throw new Error("EXPECTED_DELTAS");

  expect(result.streams.deltas).toEqual([]);
  const otherThread = await open(t, "other-thread");

  const other = await t.mutation(components.agent.streams.create, {
    threadId: otherThread.threadId,
    order: 99,
    stepOrder: 0,
  });

  await expect(
    owner(t).query(api.agents.streams, {
      threadId: turn.threadId,

      streamArgs: { kind: "deltas", cursors: [{ streamId: other, cursor: 0 }] },
    }),
  ).rejects.toThrow("Stream does not belong to the given thread");

  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

it("forty distinct delta cursors read at most two native streams and retain the earliest offset", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await activeStream(t);
  const streamIds = [turn.streamId];

  for (let i = 1; i < 40; i++)
    streamIds.push(
      await t.mutation(components.agent.streams.create, {
        threadId: turn.threadId,
        order: i + 1,
        stepOrder: 0,
        providerOptions: { huge: { value: "x".repeat(450 << 10) } },
      }),
    );

  for (const streamId of streamIds)
    await t.mutation(components.agent.streams.addDelta, {
      streamId,
      start: 0,
      end: 1,
      parts: [{ type: "text-delta", id: "text", delta: "chunk" }],
    });

  const result = await owner(t).query(api.agents.streams, {
    threadId: turn.threadId,

    streamArgs: {
      kind: "deltas",
      cursors: [
        { streamId: turn.streamId, cursor: 1 },
        ...streamIds.map((streamId) => ({ streamId, cursor: 0 })),
      ],
    },
  });

  if (result.streams?.kind !== "deltas") throw new Error("EXPECTED_DELTAS");

  expect(result.streams.deltas.map((delta) => delta.streamId)).toEqual(
    streamIds.slice(0, LIMITS.streamCursors),
  );

  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

it("eight 1020 KiB stream docs and nine large deltas stay within transaction read limits", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await activeStream(t, 1020 << 10);
  const streamIds = [turn.streamId];

  for (let i = 1; i < 8; i++)
    streamIds.push(
      await t.mutation(components.agent.streams.create, {
        threadId: turn.threadId,
        order: i + 1,
        stepOrder: 0,
        providerOptions: { huge: { value: "x".repeat(1020 << 10) } },
      }),
    );

  // Put the page on the last accepted cursor so both max-size stream
  // documents are read before Agent exhausts the shared 8 MiB delta budget.
  for (let i = 0; i < 9; i++)
    await t.mutation(components.agent.streams.addDelta, {
      streamId: streamIds[LIMITS.streamCursors - 1],
      start: i,
      end: i + 1,
      parts: [{ type: "text-delta", id: "text", delta: "x".repeat(1020 << 10) }],
    });

  const result = await owner(t).query(api.agents.streams, {
    threadId: turn.threadId,

    streamArgs: { kind: "deltas", cursors: streamIds.map((streamId) => ({ streamId, cursor: 0 })) },
  });

  if (result.streams?.kind !== "deltas") throw new Error("EXPECTED_DELTAS");

  expect(result.streams.deltas.length).toBeGreaterThan(0);
  expect(result.streams.deltas.length).toBeLessThanOrEqual(9);
  expect(JSON.stringify(result.streams.deltas).length).toBeLessThan(9 << 20);

  expect(
    result.streams.deltas.every((delta) => delta.streamId === streamIds[LIMITS.streamCursors - 1]),
  ).toBe(true);

  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

it.each(["messages", "streams"] as const)(
  "%s has its own transaction budget with six near-1 MiB branch heads, two streams and nine deltas",
  async (reader) => {
    const t = setup(undefined, undefined, true);
    const turn = await activeStream(t, 1020 << 10);

    const other = await t.mutation(components.agent.streams.create, {
      threadId: turn.threadId,
      order: 2,
      stepOrder: 0,
      providerOptions: { huge: { value: "x".repeat(1020 << 10) } },
    });

    for (let i = 0; i < 9; i++)
      await t.mutation(components.agent.streams.addDelta, {
        streamId: other,
        start: i,
        end: i + 1,
        parts: [{ type: "text-delta", id: "text", delta: "x".repeat(1020 << 10) }],
      });

    // One large document in EVERY native merge branch, not six documents in
    // the same branch. Without counting all six prefetches the former combined
    // query exceeds 16 MiB. Each save itself remains a separate transaction.
    for (const status of ["success", "pending", "failed"] as const)
      for (const tool of [false, true]) {
        const saved = await t.mutation(components.agent.messages.addMessages, {
          threadId: turn.threadId,
          order: "next",
          failPendingSteps: false,
          messages: [
            {
              status,
              message: tool
                ? {
                    role: "tool",
                    content: [
                      {
                        type: "tool-result",
                        toolCallId: `large-${status}`,
                        toolName: "echo",
                        output: { type: "text", value: "x".repeat(1020 << 10) },
                      },
                    ],
                  }
                : { role: "user", content: "x".repeat(510 << 10) },
            },
          ],
        });

        expect(getConvexSize(saved.messages[0])).toBeGreaterThan(1010 << 10);
        expect(getConvexSize(saved.messages[0])).toBeLessThan(1 << 20);
      }

    const streamArgs = {
      kind: "deltas" as const,
      cursors: [turn.streamId, other].map((streamId) => ({ streamId, cursor: 0 })),
    };

    if (reader === "messages") {
      const { result, bytes } = await owner(t).run(async (ctx) => {
        const result = await ctx.runQuery(api.agents.messages, {
          threadId: turn.threadId,
          paginationOpts: { cursor: null, numItems: LIMITS.messagePage },
        });

        return { result, bytes: (await ctx.meta.getTransactionMetrics()).bytesRead.used };
      });

      expect(result.page.length).toBeGreaterThan(0);
      expect(result.isDone).toBe(false);
      expect(bytes).toBeLessThanOrEqual(7.75 * (1 << 20));
    } else {
      const { result, bytes } = await owner(t).run(async (ctx) => {
        const result = await ctx.runQuery(api.agents.streams, {
          threadId: turn.threadId,
          streamArgs,
        });

        return { result, bytes: (await ctx.meta.getTransactionMetrics()).bytesRead.used };
      });

      if (result.streams?.kind !== "deltas") throw new Error("EXPECTED_DELTAS");

      expect(result.streams.deltas).toHaveLength(9);
      expect(bytes).toBeLessThanOrEqual(11.25 * (1 << 20));
    }

    await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
    await drain(t);
  },
);

it("native byte-bounded delta pages preserve continuation", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await activeStream(t);
  const deltaHandle = await t.run(() => createFunctionHandle(components.agent.streams.addDelta));

  for (let i = 0; i < 24; i++)
    await t.mutation(components.agevex.turns.slices.write, {
      assignmentId: turn.assignmentId,
      executionId: turn.executionId,
      cancellationEpoch: 0,
      handle: deltaHandle,
      args: {
        streamId: turn.streamId,
        start: i,
        end: i + 1,
        parts: [{ type: "text-delta", id: "text", delta: "x".repeat(450 << 10) }],
      },
    });

  const seen = new Set<number>();
  let cursor = 0;

  for (let pages = 0; pages < 12; pages++) {
    const result = await owner(t).query(api.agents.streams, {
      threadId: turn.threadId,

      streamArgs: { kind: "deltas", cursors: [{ streamId: turn.streamId, cursor }] },
    });

    if (result.streams?.kind !== "deltas") throw new Error("EXPECTED_DELTAS");

    if (!result.streams.deltas.length) break;

    expect(result.streams.deltas.length).toBeLessThan(24);

    for (const delta of result.streams.deltas) {
      expect(seen.has(delta.start)).toBe(false);
      seen.add(delta.start);
      cursor = delta.end;
    }
  }

  expect(seen.size).toBe(24);
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

it.each(["numItems", "maximumBytesRead", "maximumRowsRead"] as const)(
  "rejects NaN and invalid integers in %s before native pagination",
  async (key) => {
    const t = setup();
    const receipt = await open(t);

    await drain(t);

    for (const value of [NaN, Infinity, -1, 1.5]) {
      await expect(
        owner(t).query(api.agents.messages, {
          threadId: receipt.threadId,
          paginationOpts: { cursor: null, numItems: 1, [key]: value },
        }),
      ).rejects.toThrow("INVALID_PAGINATION");
    }
  },
);

it("endCursor [] over 151 messages respects the row cap and supports reactive splits", async () => {
  const t = setup(undefined, undefined, true);
  const receipt = await open(t);

  // Do not run the admitted generation; create exactly 151 native messages.
  for (let i = 0; i < 150; i++)
    await t.run((ctx) =>
      saveMessage(ctx, components.agent, { threadId: receipt.threadId, prompt: `message ${i}` }),
    );

  const opts = { cursor: null, numItems: 1, endCursor: "[]", maximumRowsRead: 10_000 };

  const page = await owner(t).query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: opts,
  });

  expect(page.page).toHaveLength(LIMITS.messagePage);
  expect(page.isDone).toBe(false);
  expect(page.pageStatus).toBe("SplitRequired");

  const next = await owner(t).query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { ...opts, cursor: page.continueCursor },
  });

  expect(next.page).toHaveLength(51);
  expect(new Set([...page.page, ...next.page].map((m) => m.id)).size).toBe(151);

  const split = await owner(t).query(api.agents.messages, {
    threadId: receipt.threadId,
    paginationOpts: { ...opts, endCursor: page.splitCursor },
  });

  expect(split.page.length).toBeGreaterThan(0);
  expect(split.page.length).toBeLessThanOrEqual(LIMITS.messagePage);
  expect(page.page.map((m) => m.id)).toEqual(expect.arrayContaining(split.page.map((m) => m.id)));
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  await drain(t);
});

it("provider continuation consumes its decision atomically and permits a second approval", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await request(t, 1, true);

  await owner(t).mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: "approval-0",
    decision: { kind: "approve" as const },
  });

  const queued = (await execution(t, turn.assignmentId))!;

  await t.mutation(components.agevex.turns.slices.claim, {
    assignmentId: turn.assignmentId,
    turnToken: queued.turnToken!,
  });

  const args = {
    assignmentId: turn.assignmentId,
    executionId: queued.turnToken!,
    cancellationEpoch: queued.cancellationEpoch,
    ...(await nativeHandles(t)),
    args: {
      threadId: turn.threadId,
      promptMessageId: queued.promptMessageId,
      failPendingSteps: false,
      messages: [
        {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "next-call",
                toolName: "echo",
                input: {},
                providerExecuted: true,
              },
              {
                type: "tool-approval-request",
                approvalId: "next-approval",
                toolCallId: "next-call",
              },
            ],
          },
        },
      ],
    },
  };

  await t.mutation(components.agevex.turns.slices.write, args);
  const next = (await execution(t, turn.assignmentId))!;

  expect(next.errorCode).toBeNull();
  expect(next.approvals?.requests).toHaveLength(1);

  await owner(t).mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: "next-approval",
    decision: { kind: "reject" as const },
  });

  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
  const native = JSON.stringify((await nativePage(t, turn.threadId)).page);

  expect(native).not.toContain('"toolCallId":"call-0","toolName":"echo","output"');

  const results = (await nativePage(t, turn.threadId)).page.flatMap((doc) =>
    doc.message?.role === "tool"
      ? doc.message.content.filter((part) => part.type === "tool-result")
      : [],
  );

  expect(results).toMatchObject([{ toolCallId: "next-call" }]);
});

it("cancel after a consumed provider approval appends no result or decision", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await request(t, 1, true);

  await owner(t).mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: "approval-0",
    decision: { kind: "reject" as const },
  });

  const queued = (await execution(t, turn.assignmentId))!;

  await t.mutation(components.agevex.turns.slices.claim, {
    assignmentId: turn.assignmentId,
    turnToken: queued.turnToken!,
  });

  await t.mutation(components.agevex.turns.slices.write, {
    assignmentId: turn.assignmentId,
    executionId: queued.turnToken!,
    cancellationEpoch: queued.cancellationEpoch,
    ...(await nativeHandles(t)),
    args: {
      threadId: turn.threadId,
      promptMessageId: queued.promptMessageId,
      failPendingSteps: false,
      messages: [
        { message: { role: "assistant", content: [{ type: "text", text: "provider finished" }] } },
      ],
    },
  });

  const before = (await nativePage(t, turn.threadId)).page;

  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
  expect((await nativePage(t, turn.threadId)).page).toEqual(before);
});

it("streams rejects non-finite, negative and fractional start orders and cursors", async () => {
  const t = setup();
  const receipt = await open(t);

  const streamId = await t.mutation(components.agent.streams.create, {
    threadId: receipt.threadId,
    order: 1,
    stepOrder: 0,
  });

  for (const value of [NaN, Infinity, -1, 1.5]) {
    await expect(
      owner(t).query(api.agents.streams, {
        threadId: receipt.threadId,
        streamArgs: { kind: "list", startOrder: value },
      }),
    ).rejects.toThrow("INVALID_STREAM_ORDER");

    await expect(
      owner(t).query(api.agents.streams, {
        threadId: receipt.threadId,
        streamArgs: { kind: "deltas", cursors: [{ streamId, cursor: value }] },
      }),
    ).rejects.toThrow("INVALID_STREAM_CURSOR");
  }

  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  await drain(t);
});

it.each([true, false])(
  "notes during an approval pause follow committed tool results at the next claim (approved=%s)",
  async (approved) => {
    const t = setup(undefined, undefined, true);
    const turn = await request(t, 2);

    await drain(t);

    await t.mutation(components.agevex.hooks.notes.addNote, {
      assignmentId: turn.assignmentId,
      text: "approval-pause advice",
      from: "critic",
    });

    expect(
      (await nativePage(t, turn.threadId)).page.some((message) =>
        message.text?.includes("approval-pause advice"),
      ),
    ).toBe(false);

    for (let index = 0; index < 2; index++) {
      await owner(t).mutation(api.agents.respond, {
        threadId: turn.threadId,
        approvalId: "approval-" + index,
        decision: { kind: approved ? "approve" : "reject" },
      });

      if (index === 0) {
        await drain(t);
        expect(state.calls).toHaveLength(0);

        expect(
          (await nativePage(t, turn.threadId)).page.some((message) =>
            message.text?.includes("approval-pause advice"),
          ),
        ).toBe(false);
      }
    }

    await drain(t);
    expect(state.calls).toHaveLength(1);
    expect(JSON.stringify(state.calls[0].prompt)).not.toContain("approval-pause advice");
    expect(await execution(t, turn.assignmentId)).toMatchObject({ notesPending: 1 });
    expect((await execution(t, turn.assignmentId))?.approvals).toBeUndefined();

    const results = (await nativePage(t, turn.threadId)).page.flatMap((doc) =>
      doc.message?.role === "tool"
        ? doc.message.content.filter((part) => part.type === "tool-result")
        : [],
    );

    expect(results.map((part) => part.toolCallId).sort()).toEqual(["call-0", "call-1"]);

    await owner(t).mutation(api.agents.send, {
      threadId: turn.threadId,
      text: "read approval-pause notes",
      requestKey: "read approval-pause notes",
    });

    await drain(t);
    expect(state.calls).toHaveLength(2);
    expect(JSON.stringify(state.calls[1].prompt).match(/approval-pause advice/g)).toHaveLength(1);
    expect(await execution(t, turn.assignmentId)).toMatchObject({ notesPending: 0 });

    const page = (await nativePage(t, turn.threadId)).page.sort(
      (a, b) => a.order - b.order || a.stepOrder - b.stepOrder,
    );

    const unresolved = new Set<string>();

    for (const doc of page) {
      if (doc.text?.includes("approval-pause advice")) expect(unresolved.size).toBe(0);

      if (!Array.isArray(doc.message?.content)) continue;

      for (const part of doc.message.content) {
        if (part.type === "tool-call") unresolved.add(part.toolCallId);

        if (part.type === "tool-result") unresolved.delete(part.toolCallId);
      }
    }

    expect(unresolved.size).toBe(0);
  },
);

it("provider-executed calls refuse edits and keep the original approval pending", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await request(t, 1, true);

  await expect(
    owner(t).mutation(api.agents.respond, {
      threadId: turn.threadId,
      approvalId: "approval-0",
      decision: { kind: "approve", edit: { input: { text: "edit" } } },
    }),
  ).rejects.toThrow("APPROVAL_NOT_EDITABLE");

  expect((await execution(t, turn.assignmentId))?.approvalBlocked).toBe(true);

  await owner(t).mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: "approval-0",
    decision: { kind: "reject" },
  });

  await drain(t);
});
