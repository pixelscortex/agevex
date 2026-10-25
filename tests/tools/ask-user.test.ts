// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setup, api, native, state } from "./setup.js";
import { rawAssignment } from "../fixture/api.js";
import { requireReceipt } from "../receipt.js";
import { ASK_USER_LIMITS } from "../../src/modules/tools/registry/ask-user/askUser.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));

const ask = (toolCallId: string, input: unknown) => [
  { type: "tool-call" as const, toolName: "ask_user", toolCallId, input: JSON.stringify(input) },
];

it("ask_user pauses the run as a pending deferred call; answer resumes it once and the model sees the exact text", async () => {
  const t = setup();
  const question = "界".repeat(ASK_USER_LIMITS.questionChars);

  state.steps.push(ask("ask-1", { question }));
  const alice = t.withIdentity({ subject: "alice" });

  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Plan it", requestKey: "ask" }),
  );

  await drain(t);

  // Pending: the model produced its call and the turn is waiting, with no
  // second generation and no approval request (this is not a yes/no gate).
  expect(state.calls).toHaveLength(1);
  const execution = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

  expect(execution?.approvals?.requests).toHaveLength(1);
  expect(execution?.approvals?.requests[0]).toMatchObject({ deferred: true });

  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 1,
  });

  const args = { threadId: receipt.threadId, toolCallId: "ask-1", text: "Use the 界 plan" };

  await expect(t.withIdentity({ subject: "bob" }).mutation(api.host.answer, args)).rejects.toThrow(
    "FORBIDDEN",
  );

  expect(state.calls).toHaveLength(1);

  const answered = await alice.mutation(api.host.answer, args);

  const [saved] = await t.query(native.messages.getMessagesByIds, {
    messageIds: [answered.messageId],
  });

  expect(saved?.message).toEqual({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "ask-1",
        toolName: "ask_user",
        output: { type: "text", value: args.text },
      },
    ],
  });

  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[1].prompt)).toContain(args.text);
  // A repeated answer replays the original result and never resumes twice.
  expect(answered.replayed).toBe(false);

  await expect(alice.mutation(api.host.answer, args)).resolves.toEqual({
    ...answered,
    replayed: true,
  });

  await drain(t);
  expect(state.calls).toHaveLength(2);

  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it("ask_user rejects blank, oversized and model-supplied ownership questions without pausing", async () => {
  const t = setup();

  const invalid = [
    { question: "   " },
    { question: "x".repeat(ASK_USER_LIMITS.questionChars + 1) },
    { question: "Can I?", subject: "bob", threadId: "foreign" },
  ];

  for (const [index, input] of invalid.entries()) state.steps.push(ask(`invalid-${index}`, input));

  const alice = t.withIdentity({ subject: "alice" });

  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Ask", requestKey: "invalid" }),
  );

  await drain(t);
  // Every invalid call became an ordinary tool error the model could correct;
  // the run finished after the fourth generation instead of waiting for a human.
  expect(state.calls).toHaveLength(4);
  const execution = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

  expect(execution?.approvals?.requests ?? []).toHaveLength(0);

  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
  });
});
