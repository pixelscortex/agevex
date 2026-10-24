// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createFunctionHandle } from "convex/server";
import { getConvexSize } from "convex/values";
import { listMessages, saveMessage } from "@convex-dev/agent";
import { setup, api, components, state } from "./setup.js";
import { main } from "./host.js";
import type { ManagedAgent } from "../src/client/index.js";
import { LIMITS } from "../src/client/index.js";

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
  owner(t).mutation(api.agents.open, {
    agent: "Main",
    prompt: "bounded reads",
    requestKey: key,
  });
const execution = (t: Test, assignmentId: string) =>
  t.query(components.agevex.queue.execution, { assignmentId });
// Test-only inspection of the small native fixtures; runtime never scans history.
const nativePage = (t: Test, threadId: string) =>
  t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor: null, numItems: 100, maximumBytesRead: 2 << 20 },
    }),
  );
async function claimed(t: Test) {
  const receipt = await open(t);
  const row = (await execution(t, receipt.assignmentId))!;
  await t.mutation(components.agevex.queue.claim, {
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
  const writeResult = await t.mutation(components.agevex.queue.write, {
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
    approved: true,
  });
  await drain(t);
  expect(state.calls).toHaveLength(0);
  expect(await execution(t, turn.assignmentId)).toMatchObject({ approvalBlocked: true });
  await expect(
    alice.mutation(api.agents.respond, {
      threadId: turn.threadId,
      approvalId: "approval-0",
      approved: true,
    }),
  ).rejects.toThrow("APPROVAL_ALREADY_RESOLVED");
  const last = await alice.mutation(api.agents.respond, {
    threadId: turn.threadId,
    approvalId: "approval-1",
    approved: false,
    reason: "declined",
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

it("respond preserves provider-executed flags and rejects other owners", async () => {
  const t = setup();
  const turn = await request(t, 1, true);
  const decision = { threadId: turn.threadId, approvalId: "approval-0", approved: false };
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
  const assignment = await t.query(components.agevex.queue.assignment, { threadId: childThreadId });
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
  const decision = { threadId: childThreadId, approvalId: part.approvalId, approved: false };
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
      approved: false,
    });
    const row = (await execution(t, turn.assignmentId))!;
    expect(row.approvals?.resolved).toHaveLength(i + 1);
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
  await t.mutation(components.agevex.queue.finish, {
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
  ).rejects.toThrow("RECOVERY_REQUIRED");
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
        approved: true,
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

it("a genuine managed APPROVAL_LIMIT can cancel and complete a fresh send without orphan approvals", async () => {
  const t = setup(undefined, undefined, true);
  state.approval = true;
  state.approvalCount = LIMITS.approvalsPerPause + 1;
  const receipt = await open(t);
  await drain(t);
  expect(await execution(t, receipt.assignmentId)).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "APPROVAL_LIMIT",
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
    approved: true,
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
    approved: true,
  });
  expect((await execution(t, turn.assignmentId))?.approvals?.requests[0].state).toBe("approved");
  await expect
    .poll(async () => {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      return state.echoStarted;
    })
    .toBe(true);
  expect((await execution(t, turn.assignmentId))?.approvals?.requests[0].state).toBe("running");
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
      approved: true,
    });
  const row = (await execution(t, turn.assignmentId))!;
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: turn.assignmentId,
    turnToken: row.turnToken!,
  });
  await t.mutation(components.agevex.queue.write, {
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
    approved: false,
  });
  expect(await execution(t, turn.assignmentId)).toMatchObject({ approvalBlocked: false });
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

async function activeStream(t: Test, bytes = 450 << 10) {
  const turn = await claimed(t);
  await t.mutation(components.agevex.queue.write, {
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
  const streamId = (await t.mutation(components.agevex.queue.write, {
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
    owner(t).query(api.agents.messages, {
      threadId: turn.threadId,
      paginationOpts: { cursor: null, numItems: 1 },
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
  const result = await owner(t).query(api.agents.messages, {
    threadId: turn.threadId,
    paginationOpts: { cursor: null, numItems: 1 },
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
    owner(t).query(api.agents.messages, {
      threadId: turn.threadId,
      paginationOpts: { cursor: null, numItems: 1 },
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
  const result = await owner(t).query(api.agents.messages, {
    threadId: turn.threadId,
    paginationOpts: { cursor: null, numItems: 1 },
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
  const result = await owner(t).query(api.agents.messages, {
    threadId: turn.threadId,
    paginationOpts: { cursor: null, numItems: 1 },
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

it.each([3, LIMITS.streamCursors - 1])(
  "combined ten 850 KiB results four 1020 KiB streams and nine deltas on cursor %i leave 2 MiB margin",
  async (deltaIndex) => {
    // Enforce the promised headroom, rather than just Convex's 16 MiB ceiling.
    const t = setup(undefined, undefined, { bytesRead: 14 << 20 });
    const turn = await activeStream(t, 1020 << 10);
    const streamIds = [turn.streamId];
    for (let i = 1; i < 4; i++)
      streamIds.push(
        await t.mutation(components.agent.streams.create, {
          threadId: turn.threadId,
          order: i + 1,
          stepOrder: 0,
          providerOptions: { huge: { value: "x".repeat(1020 << 10) } },
        }),
      );
    for (let i = 0; i < 9; i++)
      await t.mutation(components.agent.streams.addDelta, {
        streamId: streamIds[deltaIndex],
        start: i,
        end: i + 1,
        parts: [{ type: "text-delta", id: "text", delta: "x".repeat(1020 << 10) }],
      });
    const calls = await t.run((ctx) =>
      saveMessage(ctx, components.agent, {
        threadId: turn.threadId,
        order: "next",
        message: {
          role: "assistant",
          content: Array.from({ length: 10 }, (_, i) => ({
            type: "tool-call" as const,
            toolCallId: `large-${i}`,
            toolName: "echo",
            input: {},
          })),
        },
      }),
    );
    for (let i = 0; i < 10; i++)
      await t.run((ctx) =>
        saveMessage(ctx, components.agent, {
          threadId: turn.threadId,
          promptMessageId: calls.messageId,
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: `large-${i}`,
                toolName: "echo",
                output: { type: "text", value: "x".repeat(850 << 10) },
              },
            ],
          },
        }),
      );
    const { result, metrics } = await owner(t).run(async (ctx) => {
      const result = await ctx.runQuery(api.agents.messages, {
        threadId: turn.threadId,
        paginationOpts: { cursor: null, numItems: 100 },
        streamArgs: {
          kind: "deltas",
          cursors: streamIds.map((streamId) => ({ streamId, cursor: 0 })),
        },
      });
      return { result, metrics: await ctx.meta.getTransactionMetrics() };
    });
    expect(result.page.length).toBeGreaterThan(0);
    expect(result.isDone).toBe(false);
    expect(metrics.bytesRead.used).toBeLessThanOrEqual(13.75 * (1 << 20));
    if (result.streams?.kind !== "deltas") throw new Error("EXPECTED_DELTAS");
    expect(result.streams.deltas).toHaveLength(deltaIndex < LIMITS.streamCursors ? 9 : 0);
    await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
    await drain(t);
  },
);

it("native byte-bounded delta pages preserve continuation", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await activeStream(t);
  const deltaHandle = await t.run(() => createFunctionHandle(components.agent.streams.addDelta));
  for (let i = 0; i < 24; i++)
    await t.mutation(components.agevex.queue.write, {
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
    const result = await owner(t).query(api.agents.messages, {
      threadId: turn.threadId,
      paginationOpts: { cursor: null, numItems: 1 },
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
