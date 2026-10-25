// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setup, api, native, managed, state } from "./setup.js";
import { requireReceipt } from "../receipt.js";
import {
  CONSENT_TEXT,
  CONSENT_LIMITS,
  CONTINUE_BUDGET_LIMITS,
} from "../../docs/site/registry/continue-budget/continueBudget.js";
import { LIMITS } from "../../src/client/index.js";

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

const limit = (t: Test, subject: string, value: number) =>
  t.run(async (ctx) => {
    await ctx.db.insert("budgets", { subject, limit: value });
  });
const budgetRows = (t: Test) => t.run((ctx) => ctx.db.query("budgets").collect());

/**
 * The README flow against a fake budget slot reading a host budget row. The
 * model asks for consent, the user approves it, and the very next slice is
 * denied by the slot with BUDGET_EXCEEDED. `slices` is the total the policy
 * allowed before this stop.
 */
type Answer = "approve" | "core-only" | "deny";
async function stoppedForBudget(
  t: Test,
  slices: number,
  requestKey: string,
  answer: Answer = "approve",
) {
  const alice = t.withIdentity({ subject: "alice" });
  state.steps.splice(
    state.calls.length,
    0,
    requestConsent(`consent-${requestKey}`, { reason: "Need more" }),
  );
  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Go", requestKey }),
  );
  await drain(t);
  const approval = await approvalId(t, receipt.assignmentId);
  const args = { threadId: receipt.threadId, approvalId: approval };
  // "approve" is the host's approve action (core respond + consent record in one
  // transaction). "core-only" answers through core respond and records nothing.
  if (answer === "approve") await alice.mutation(api.host.approveContinue, args);
  else await alice.mutation(api.host.respond, { ...args, approved: answer === "core-only" });
  await drain(t);
  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "BUDGET_EXCEEDED",
  });
  expect(state.budget.checks).toBe(slices);
  return { alice, receipt, approval };
}
const resume = (
  alice: ReturnType<Test["withIdentity"]>,
  threadId: string,
  approvalId: string,
  instruction?: string,
) => alice.mutation(api.host.resumeAfterBudget, { threadId, approvalId, instruction });

it("recording consent alone never raises the budget or resumes: the run stays stopped until the resume mutation runs", async () => {
  const t = setup();
  await limit(t, "alice", 1);
  const { alice, receipt } = await stoppedForBudget(t, 2, "first");
  await drain(t);
  expect(state.calls).toHaveLength(1);
  expect((await budgetRows(t))[0].limit).toBe(1);
  // Core refuses new work on the stopped run until the host cancels it.
  await expect(
    alice.mutation(api.host.send, { threadId: receipt.threadId, text: "Try", requestKey: "early" }),
  ).resolves.toMatchObject({ status: "rejected", code: "RECOVERY_REQUIRED" });
});

it("with recorded host consent one mutation raises the budget, cancels the stopped run and sends a fresh run that states the consent", async () => {
  const t = setup();
  await limit(t, "alice", 1);
  const { alice, receipt, approval } = await stoppedForBudget(t, 2, "first");
  const stoppedRun = state.budget.runIds[0];
  const result = await resume(alice, receipt.threadId, approval);
  expect(result).toMatchObject({ status: "resumed", receipt: { status: "accepted" } });
  await drain(t);
  expect(state.calls).toHaveLength(2);
  const prompt = JSON.stringify(state.calls[1].prompt);
  expect(prompt).toContain(CONSENT_TEXT);
  // The model's original approval call is settled as denied by the cancel; the
  // explicit consent text is what tells it the user actually approved.
  expect(prompt).toContain("execution-denied");
  expect(state.budget.runIds[state.budget.runIds.length - 1]).not.toBe(stoppedRun);
  expect((await budgetRows(t))[0].limit).toBe(3);
  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it("overlapping resumes admit exactly one fresh run and never cancel it", async () => {
  const t = setup();
  await limit(t, "alice", 1);
  const { alice, receipt, approval } = await stoppedForBudget(t, 2, "first");
  const results = await Promise.all([
    resume(alice, receipt.threadId, approval),
    resume(alice, receipt.threadId, approval),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(["not-stopped", "resumed"]);
  await drain(t);
  // The single fresh run completed: the loser did not cancel it or send twice.
  expect(state.calls).toHaveLength(2);
  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
  const messages = await alice.query(api.host.messages, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 50 },
  });
  expect(
    messages.page.filter((m) => m.role === "user" && m.text.includes(CONSENT_TEXT)),
  ).toHaveLength(1);
});

it("the same thread can be stopped and resumed again: each stop gets its own request key", async () => {
  const t = setup();
  await limit(t, "alice", 1);
  const first = await stoppedForBudget(t, 2, "first");
  await expect(resume(first.alice, first.receipt.threadId, first.approval)).resolves.toMatchObject({
    status: "resumed",
  });
  // The fresh run asks for consent again and is stopped again (3 slices allowed).
  state.steps.push(requestConsent("consent-second", { reason: "Still need more" }));
  await drain(t);
  expect(state.calls).toHaveLength(2);
  const second = await approvalId(t, first.receipt.assignmentId);
  expect(second).not.toBe(first.approval);
  await first.alice.mutation(api.host.approveContinue, {
    threadId: first.receipt.threadId,
    approvalId: second,
  });
  await drain(t);
  expect(
    await first.alice.query(api.host.activity, { threadId: first.receipt.threadId }),
  ).toMatchObject({
    errorCode: "BUDGET_EXCEEDED",
  });
  await expect(resume(first.alice, first.receipt.threadId, second)).resolves.toMatchObject({
    status: "resumed",
    receipt: { status: "accepted" },
  });
  await drain(t);
  expect(state.calls).toHaveLength(3);
  expect(
    await first.alice.query(api.host.activity, { threadId: first.receipt.threadId }),
  ).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it.each([
  ["approved through core respond but never recorded as host consent", "core-only"],
  ["denied approval", "deny"],
  ["unknown approval id", "approve"],
] as const)("%s is not consent: nothing is raised, cancelled or sent", async (kind, answer) => {
  const t = setup();
  await limit(t, "alice", 1);
  const { alice, receipt, approval } = await stoppedForBudget(t, 2, "first", answer);
  const before = (await budgetRows(t))[0].limit;
  const calls = state.calls.length;
  await expect(
    resume(alice, receipt.threadId, kind === "unknown approval id" ? "not-an-approval" : approval),
  ).resolves.toEqual({ status: "no-consent" });
  expect((await budgetRows(t))[0].limit).toBe(before);
  await drain(t);
  expect(state.calls).toHaveLength(calls);
  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "BUDGET_EXCEEDED",
  });
});

it("a pending, never-approved approval is not consent and resuming responds to nothing on the user's behalf", async () => {
  const t = setup();
  state.steps.push(requestConsent("pending", { reason: "More" }));
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Go", requestKey: "pending" }),
  );
  await drain(t);
  const approval = await approvalId(t, receipt.assignmentId);
  const consentRows = () => t.run((ctx) => ctx.db.query("agevexBudgetConsents").collect());
  expect(await consentRows()).toEqual([]);
  await expect(resume(alice, receipt.threadId, approval)).resolves.toEqual({
    status: "not-stopped",
  });
  // The approval is still pending: no response was saved, none was recorded as
  // consent, and the paused turn did not move.
  const execution = await t.query(managed.queue.execution, { assignmentId: receipt.assignmentId });
  expect(execution?.approvalBlocked).toBe(true);
  expect(["pending", undefined]).toContain(execution?.approvals?.requests[0].state);
  expect(await consentRows()).toEqual([]);
  const [request] = await t.query(native.messages.getMessagesByIds, {
    messageIds: [execution!.approvals!.requests[0].messageId],
  });
  expect(JSON.stringify(request?.message)).not.toContain("tool-approval-response");
  await drain(t);
  expect(state.calls).toHaveLength(1);
});

it("consent is scoped to its owner, thread and approval, and is recorded idempotently", async () => {
  const t = setup();
  const scope = { subject: "alice", threadId: "thread-a", approvalId: "approval-1" };
  const rows = () => t.run((ctx) => ctx.db.query("agevexBudgetConsents").collect());
  expect(await t.query(api.continueBudgetState.has, scope)).toBe(false);
  await t.mutation(api.continueBudgetState.record, scope);
  await t.mutation(api.continueBudgetState.record, scope);
  expect(await rows()).toHaveLength(1);
  expect(await t.query(api.continueBudgetState.has, scope)).toBe(true);
  for (const other of [
    { ...scope, subject: "bob" },
    { ...scope, threadId: "thread-b" },
    { ...scope, approvalId: "approval-2" },
  ])
    expect(await t.query(api.continueBudgetState.has, other)).toBe(false);
});

it("consent storage rejects approval ids it cannot index and cleanup deletes one bounded batch", async () => {
  const t = setup();
  const scope = { subject: "alice", threadId: "thread-a" };
  for (const approvalId of ["", "x".repeat(CONSENT_LIMITS.approvalIdBytes + 1), "界".repeat(171)])
    await expect(
      t.mutation(api.continueBudgetState.record, { ...scope, approvalId }),
    ).rejects.toThrow("INVALID_APPROVAL_ID");
  const widest = "界".repeat(Math.floor(CONSENT_LIMITS.approvalIdBytes / 3));
  await t.mutation(api.continueBudgetState.record, { ...scope, approvalId: widest });
  await t.run(async (ctx) => {
    for (let i = 0; i < CONSENT_LIMITS.cleanupBatch; i++)
      await ctx.db.insert("agevexBudgetConsents", { ...scope, approvalId: `a${i}` });
    await ctx.db.insert("agevexBudgetConsents", { subject: "bob", threadId: "t", approvalId: "a" });
  });
  expect(await t.mutation(api.continueBudgetState.cleanup, { subject: "alice" })).toEqual({
    deleted: CONSENT_LIMITS.cleanupBatch,
    done: false,
  });
  expect(await t.mutation(api.continueBudgetState.cleanup, { subject: "alice" })).toEqual({
    deleted: 1,
    done: true,
  });
  expect(await t.run((ctx) => ctx.db.query("agevexBudgetConsents").collect())).toHaveLength(1);
});

it("a thread that is not stopped for budget is left untouched", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Hi", requestKey: "healthy" }),
  );
  await drain(t);
  await expect(resume(alice, receipt.threadId, "any")).resolves.toEqual({ status: "not-stopped" });
  expect(await budgetRows(t)).toEqual([]);
  expect(state.calls).toHaveLength(1);
});

it("a rejected fresh request rolls back the budget raise and the cancel so the run stays resumable", async () => {
  const t = setup();
  await limit(t, "alice", 1);
  const { alice, receipt, approval } = await stoppedForBudget(t, 2, "first");
  // Oversized text makes core's send return INVALID_MESSAGE after raise and cancel ran.
  await expect(
    resume(alice, receipt.threadId, approval, "x".repeat(LIMITS.messageLength)),
  ).rejects.toThrow("INVALID_MESSAGE");
  expect((await budgetRows(t))[0].limit).toBe(1);
  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "BUDGET_EXCEEDED",
  });
  await expect(resume(alice, receipt.threadId, approval)).resolves.toMatchObject({
    status: "resumed",
  });
});
