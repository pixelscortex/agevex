// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createFunctionHandle } from "convex/server";
import { saveMessage } from "@convex-dev/agent";
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
const open = (t: Test, key = "round8") =>
  owner(t).mutation(api.agents.open, {
    agent: "Main",
    prompt: "round eight",
    requestKey: key,
  });
const execution = (t: Test, assignmentId: string) =>
  t.query(components.agevex.queue.execution, { assignmentId });
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
async function request(t: Test, count = 2, providerExecuted = false) {
  const turn = await claimed(t);
  await t.mutation(components.agevex.queue.write, {
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
                approvalId: `approval-${i}`,
                toolCallId: `call-${i}`,
              },
            ]).flat(),
          },
        },
      ],
    },
  });
  return turn;
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
  expect(row?.approvalRequestMessageId).toBeTypeOf("string");
  const [native] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [row!.approvalRequestMessageId!],
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
    messageIds: [queued!.approvalRequestMessageId!, first.messageId, last.messageId],
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
    messageIds: [child.approvalRequestMessageId!],
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

it("kind list ignores 40 by 450 KiB native streams and returns only the recorded active id", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await activeStream(t);
  for (let i = 0; i < 40; i++)
    await t.mutation(components.agent.streams.create, {
      threadId: turn.threadId,
      order: i + 2,
      stepOrder: 0,
      providerOptions: { huge: { value: "x".repeat(450 << 10) } },
    });
  const result = await owner(t).query(api.agents.messages, {
    threadId: turn.threadId,
    paginationOpts: { cursor: null, numItems: 1 },
    streamArgs: { kind: "list" },
  });
  expect(result.streams).toMatchObject({ kind: "list", messages: [{ streamId: turn.streamId }] });
  if (result.streams?.kind !== "list") throw new Error("EXPECTED_LIST");
  expect(result.streams.messages).toHaveLength(1);
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
  const other = await t.mutation(components.agent.streams.create, {
    threadId: turn.threadId,
    order: 99,
    stepOrder: 0,
  });
  await expect(
    owner(t).query(api.agents.messages, {
      threadId: turn.threadId,
      paginationOpts: { cursor: null, numItems: 1 },
      streamArgs: { kind: "deltas", cursors: [{ streamId: other, cursor: 0 }] },
    }),
  ).rejects.toThrow("FORBIDDEN_STREAM");
  await owner(t).mutation(api.agents.cancel, { threadId: turn.threadId });
  await drain(t);
});

it("delta pages include metadata in their byte budget and preserve continuation", async () => {
  const t = setup(undefined, undefined, true);
  const turn = await activeStream(t);
  const deltaHandle = await t.run(() => createFunctionHandle(components.agent.streams.addDelta));
  for (let i = 0; i < 12; i++)
    await t.mutation(components.agevex.queue.write, {
      assignmentId: turn.assignmentId,
      executionId: turn.executionId,
      cancellationEpoch: 0,
      handle: deltaHandle,
      nativeDelta: true,
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
    expect(result.streams.deltas.length).toBeLessThan(12);
    for (const delta of result.streams.deltas) {
      expect(seen.has(delta.start)).toBe(false);
      seen.add(delta.start);
      cursor = delta.end;
    }
  }
  expect(seen.size).toBe(12);
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
