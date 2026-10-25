// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setup, api, native, managed, state } from "./setup.js";
import { requireReceipt } from "../receipt.js";
import {
  CONTINUE_BUDGET_LIMITS,
  resumeAfterBudgetStop,
} from "../../docs/site/registry/continue-budget/continueBudget.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
type Test = ReturnType<typeof setup>;
const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
const requestConsent = (toolCallId: string, input: unknown) => [
  {
    type: "tool-call" as const,
    toolName: "continue_budget",
    toolCallId,
    input: JSON.stringify(input),
  },
];

/** Read the native approval id core recorded for the pending consent request. */
async function approvalId(t: Test, assignmentId: string) {
  const execution = await t.query(managed.queue.execution, { assignmentId });
  const [request] = await t.query(native.messages.getMessagesByIds, {
    messageIds: [execution!.approvals!.requests[0].messageId],
  });
  const parts = request?.message?.content;
  const part = Array.isArray(parts)
    ? parts.find((p) => p.type === "tool-approval-request")
    : undefined;
  if (part?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");
  return part.approvalId;
}

it("continue_budget pauses at its hard maximum, authorizes the responder, and resumes once through core respond", async () => {
  const t = setup();
  const reason = "界".repeat(CONTINUE_BUDGET_LIMITS.reasonChars);
  state.steps.push(requestConsent("consent", { reason }));
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Go", requestKey: "consent" }),
  );
  await drain(t);
  expect(state.calls).toHaveLength(1);
  const execution = await t.query(managed.queue.execution, { assignmentId: receipt.assignmentId });
  expect(execution?.approvalBlocked).toBe(true);
  const response = {
    threadId: receipt.threadId,
    approvalId: await approvalId(t, receipt.assignmentId),
    approved: true,
  };
  await expect(
    t.withIdentity({ subject: "bob" }).mutation(api.host.respond, response),
  ).rejects.toThrow();
  expect(state.calls).toHaveLength(1);
  const answered = await alice.mutation(api.host.respond, response);
  await expect(alice.mutation(api.host.respond, response)).resolves.toEqual(answered);
  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[1].prompt)).toContain(`"approved":true`);
  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
  });
});

it("continue_budget denial resumes without an approved tool execution", async () => {
  const t = setup();
  state.steps.push(requestConsent("denied", { reason: "Continue?" }));
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Go", requestKey: "deny" }),
  );
  await drain(t);
  await alice.mutation(api.host.respond, {
    threadId: receipt.threadId,
    approvalId: await approvalId(t, receipt.assignmentId),
    approved: false,
    reason: "Stop here.",
  });
  await drain(t);
  expect(state.calls).toHaveLength(2);
  const prompt = JSON.stringify(state.calls[1].prompt);
  expect(prompt).toContain("execution-denied");
  expect(prompt).not.toContain('"approved":true');
});

it("continue_budget rejects blank, oversized and model-supplied ownership or budget input before asking the user", async () => {
  const t = setup();
  const invalid = [
    { reason: "   " },
    { reason: "x".repeat(CONTINUE_BUDGET_LIMITS.reasonChars + 1) },
    { reason: "More", subject: "bob", threadId: "foreign", budgetUsd: 1000 },
  ];
  for (const [index, input] of invalid.entries())
    state.steps.push(requestConsent(`invalid-${index}`, input));
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Go", requestKey: "invalid" }),
  );
  await drain(t);
  expect(state.calls).toHaveLength(4);
  const execution = await t.query(managed.queue.execution, { assignmentId: receipt.assignmentId });
  expect(execution?.approvalBlocked).not.toBe(true);
});

/**
 * Drives the README flow end to end against a fake budget slot that allows one
 * slice: the model asks for consent, the user approves, and the next slice is
 * denied by the budget slot with BUDGET_EXCEEDED.
 */
async function stoppedForBudget(t: Test) {
  state.budget.allowed = 1;
  state.steps.push(requestConsent("consent", { reason: "Need more tool calls" }));
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Go", requestKey: "budget" }),
  );
  await drain(t);
  await alice.mutation(api.host.respond, {
    threadId: receipt.threadId,
    approvalId: await approvalId(t, receipt.assignmentId),
    approved: true,
  });
  await drain(t);
  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "BUDGET_EXCEEDED",
  });
  expect(state.calls).toHaveLength(1);
  return { alice, receipt };
}
const flow = (
  t: Test,
  alice: ReturnType<Test["withIdentity"]>,
  threadId: string,
  consent: boolean,
  order: string[],
) =>
  resumeAfterBudgetStop({
    consent,
    activity: () => alice.query(api.host.activity, { threadId }),
    raiseBudget: async () => {
      order.push("raise");
      state.budget.allowed = Infinity;
    },
    cancel: async () => {
      order.push("cancel");
      await alice.mutation(api.host.cancel, { threadId });
    },
    send: async () => {
      order.push("send");
      return alice.mutation(api.host.send, {
        threadId,
        text: "Continue with the plan",
        requestKey: "after-budget",
      });
    },
  });

it("a native approval alone never raises the budget: the stopped run stays stopped without explicit consent", async () => {
  const t = setup();
  const { alice, receipt } = await stoppedForBudget(t);
  const order: string[] = [];
  await expect(flow(t, alice, receipt.threadId, false, order)).resolves.toEqual({
    status: "no-consent",
  });
  expect(order).toEqual([]);
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "BUDGET_EXCEEDED",
  });
  // Core refuses new work on the stopped run until the host cancels it.
  await expect(
    alice.mutation(api.host.send, { threadId: receipt.threadId, text: "Try", requestKey: "early" }),
  ).resolves.toMatchObject({ status: "rejected", code: "RECOVERY_REQUIRED" });
});

it("with consent a BUDGET_EXCEEDED run continues by raising the budget, cancelling the stopped run, then a fresh run is admitted", async () => {
  const t = setup();
  const { alice, receipt } = await stoppedForBudget(t);
  const stoppedRun = state.budget.runIds[0];
  const order: string[] = [];
  const result = await flow(t, alice, receipt.threadId, true, order);
  expect(result).toMatchObject({ status: "resumed", receipt: { status: "accepted" } });
  expect(order).toEqual(["raise", "cancel", "send"]);
  await drain(t);
  // The stopped step was never resumed: the model ran again only for the new
  // request, under a new run id that the (now raised) budget allowed.
  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("Continue with the plan");
  expect(state.budget.runIds[state.budget.runIds.length - 1]).not.toBe(stoppedRun);
  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
  // A retried send with the same request key is a duplicate, not a second run.
  await expect(
    alice.mutation(api.host.send, {
      threadId: receipt.threadId,
      text: "Continue with the plan",
      requestKey: "after-budget",
    }),
  ).resolves.toMatchObject({ status: "duplicate" });
  await drain(t);
  expect(state.calls).toHaveLength(2);
});

it("resumeAfterBudgetStop leaves a thread that is not stopped for budget untouched", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Hi", requestKey: "healthy" }),
  );
  await drain(t);
  const order: string[] = [];
  await expect(flow(t, alice, receipt.threadId, true, order)).resolves.toEqual({
    status: "not-stopped",
  });
  expect(order).toEqual([]);
  expect(state.calls).toHaveLength(1);
});
