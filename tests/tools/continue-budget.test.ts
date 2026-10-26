// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setup, api, native, managed, state, child } from "./setup.js";
import { rawAssignment } from "../fixture/api.js";
import { requireReceipt } from "../receipt.js";
import {
  CONSENT_TEXT,
  CONSENT_LIMITS,
  CONTINUE_BUDGET_LIMITS,
} from "../../src/modules/tools/registry/continue-budget/continueBudget.js";
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
  const execution = await t.query(rawAssignment, { assignmentId });

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

  const execution = await t.query(managed.turns.slices.execution, {
    assignmentId: receipt.assignmentId,
  });

  expect(execution?.approvalBlocked).toBe(true);

  const response = {
    threadId: receipt.threadId,
    approvalId: await approvalId(t, receipt.assignmentId),
    decision: { kind: "approve" as const },
  };

  await expect(
    t.withIdentity({ subject: "bob" }).mutation(api.host.respond, response),
  ).rejects.toThrow();

  expect(state.calls).toHaveLength(1);
  const answered = await alice.mutation(api.host.respond, response);

  expect(answered.replayed).toBe(false);

  await expect(alice.mutation(api.host.respond, response)).resolves.toEqual({
    ...answered,
    replayed: true,
  });

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
    decision: { kind: "reject" as const, reason: "Stop here." },
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

  const execution = await t.query(managed.turns.slices.execution, {
    assignmentId: receipt.assignmentId,
  });

  expect(execution?.approvalBlocked).not.toBe(true);
});

const limit = (t: Test, subject: string, value: number) =>
  t.run(async (ctx) => {
    await ctx.db.insert("budgets", { subject, limit: value });
  });

const consentRows = (t: Test) => t.run((ctx) => ctx.db.query("agevexBudgetConsents").collect());
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
  else
    await alice.mutation(api.host.respond, {
      ...args,
      decision: { kind: answer === "core-only" ? ("approve" as const) : ("reject" as const) },
    });

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

it("an approval first decided through plain core respond never becomes consent, even when approved again for a later run", async () => {
  const t = setup();

  await limit(t, "alice", 1);
  // R1 is stopped; the user's first decision on approval A went through plain core respond.
  const { alice, receipt, approval } = await stoppedForBudget(t, 2, "first", "core-only");

  // The host's admin recovery starts R2 without consent; R2 asks again and is stopped too.
  await t.run(async (ctx) => {
    const [row] = await ctx.db.query("budgets").collect();

    await ctx.db.patch("budgets", row._id, { limit: state.budget.checks + 1 });
  });

  await alice.mutation(api.host.cancel, { threadId: receipt.threadId });
  state.steps.splice(state.calls.length, 0, requestConsent("consent-r2", { reason: "Again" }));

  await alice.mutation(api.host.send, {
    threadId: receipt.threadId,
    text: "Admin recovery",
    requestKey: "admin",
  });

  await drain(t);
  const second = await approvalId(t, receipt.assignmentId);

  expect(second).not.toBe(approval);

  await alice.mutation(api.host.respond, {
    threadId: receipt.threadId,
    approvalId: second,
    decision: { kind: "approve" as const },
  });

  await drain(t);

  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    errorCode: "BUDGET_EXCEEDED",
  });

  // Approving A "again" now is a replay of the earlier decision: core says so,
  // and the host records nothing, so A cannot be bound to R2's stop.
  const replay = await alice.mutation(api.host.approveContinue, {
    threadId: receipt.threadId,
    approvalId: approval,
  });

  expect(replay.replayed).toBe(true);
  expect(await consentRows(t)).toEqual([]);

  await expect(resume(alice, receipt.threadId, approval)).resolves.toEqual({
    status: "no-consent",
  });
});

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
  // The consent was spent by the resume that used it (kept, so a replayed
  // approve cannot create a fresh one).
  expect(await consentRows(t)).toMatchObject([{ spent: true }]);

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

  // Core `respond` replays its saved result for 7 days without re-checking that
  // the approval is pending, so a double-click on the first approve after the
  // resume must not re-create consent bound to the new run.
  await first.alice.mutation(api.host.approveContinue, {
    threadId: first.receipt.threadId,
    approvalId: first.approval,
  });

  expect((await consentRows(t)).filter((row) => !row.spent)).toHaveLength(1);
  // The first approval was spent by the first resume: it cannot unlock this stop.
  const limitBefore = (await budgetRows(t))[0].limit;

  await expect(resume(first.alice, first.receipt.threadId, first.approval)).resolves.toEqual({
    status: "no-consent",
  });

  expect((await budgetRows(t))[0].limit).toBe(limitBefore);

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

  expect(await consentRows(t)).toEqual([]);

  await expect(resume(alice, receipt.threadId, approval)).resolves.toEqual({
    status: "not-stopped",
  });

  // The approval is still pending: no response was saved, none was recorded as
  // consent, and the paused turn did not move.
  const execution = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

  expect(execution?.approvalBlocked).toBe(true);
  expect(execution?.approvals?.requests[0].resolved).toBeUndefined();
  expect(await consentRows(t)).toEqual([]);

  const [request] = await t.query(native.messages.getMessagesByIds, {
    messageIds: [execution!.approvals!.requests[0].messageId],
  });

  expect(JSON.stringify(request?.message)).not.toContain("tool-approval-response");
  await drain(t);
  expect(state.calls).toHaveLength(1);
});

it("consent is scoped to its owner, thread, approval and run, and is recorded idempotently", async () => {
  const t = setup();

  const scope = {
    subject: "alice",
    threadId: "thread-a",
    approvalId: "approval-1",
    runId: "run-1",
  };

  expect(await t.mutation(api.continueBudgetState.consume, scope)).toBe(false);
  await t.mutation(api.continueBudgetState.record, scope);
  await t.mutation(api.continueBudgetState.record, scope);
  expect(await consentRows(t)).toHaveLength(1);

  for (const other of [
    { ...scope, subject: "bob" },
    { ...scope, threadId: "thread-b" },
    { ...scope, approvalId: "approval-2" },
    { ...scope, runId: "run-2" },
  ])
    expect(await t.mutation(api.continueBudgetState.consume, other)).toBe(false);

  expect(await consentRows(t)).toMatchObject([{ spent: false }]);
});

it("consent is single-use even for the same run: a second consume and a re-record both fail", async () => {
  const t = setup();

  const scope = {
    subject: "alice",
    threadId: "thread-a",
    approvalId: "approval-1",
    runId: "run-1",
  };

  await t.mutation(api.continueBudgetState.record, scope);
  expect(await t.mutation(api.continueBudgetState.consume, scope)).toBe(true);
  expect(await t.mutation(api.continueBudgetState.consume, scope)).toBe(false);
  // A replayed approve calls record again for the same run; the spent row wins.
  await t.mutation(api.continueBudgetState.record, scope);
  expect(await consentRows(t)).toMatchObject([{ spent: true }]);
  expect(await t.mutation(api.continueBudgetState.consume, scope)).toBe(false);
});

it("consent storage rejects approval ids it cannot index", async () => {
  const t = setup();
  const scope = { subject: "alice", threadId: "thread-a", runId: "run-1" };

  for (const approvalId of ["", "x".repeat(CONSENT_LIMITS.approvalIdBytes + 1), "界".repeat(171)])
    await expect(
      t.mutation(api.continueBudgetState.record, { ...scope, approvalId }),
    ).rejects.toThrow("INVALID_APPROVAL_ID");

  const widest = "界".repeat(Math.floor(CONSENT_LIMITS.approvalIdBytes / 3));

  await t.mutation(api.continueBudgetState.record, { ...scope, approvalId: widest });

  expect(await t.mutation(api.continueBudgetState.consume, { ...scope, approvalId: widest })).toBe(
    true,
  );
});

it("cleanup never deletes consent younger than core's response-receipt retention and deletes one bounded batch after it", async () => {
  const t = setup();
  const scope = { subject: "alice", threadId: "thread-a", runId: "run-1", spent: true };

  await t.run(async (ctx) => {
    for (let i = 0; i < CONSENT_LIMITS.cleanupBatch + 1; i++)
      await ctx.db.insert("agevexBudgetConsents", { ...scope, approvalId: `a${i}` });

    await ctx.db.insert("agevexBudgetConsents", {
      ...scope,
      threadId: "thread-b",
      approvalId: "a",
    });
  });

  const clean = (threadId = "thread-a") =>
    t.mutation(api.continueBudgetState.cleanup, { subject: "alice", threadId });

  // Core serves a saved respond result until its hourly purge deletes the
  // receipt, so the safe age is retention + purge interval + 1 hour margin.
  const retention = LIMITS.receiptRetentionMs + LIMITS.purgeIntervalMs + 60 * 60_000;

  vi.setSystemTime(Date.now() + retention - 60_000);
  expect(await clean()).toEqual({ deleted: 0, done: true });
  expect(await consentRows(t)).toHaveLength(CONSENT_LIMITS.cleanupBatch + 2);
  vi.setSystemTime(Date.now() + 120_000);
  expect(await clean()).toEqual({ deleted: CONSENT_LIMITS.cleanupBatch, done: false });
  expect(await clean()).toEqual({ deleted: 1, done: true });
  // Only the target thread was cleaned.
  expect(await consentRows(t)).toMatchObject([{ threadId: "thread-b" }]);
});

it("a delegated child cannot record consent through the approve action, and calling continue_budget returns a typed ROOT_ONLY denial", async () => {
  const t = setup();

  state.steps.push([
    {
      type: "tool-call",
      toolName: "agevex_delegate",
      toolCallId: "delegate",
      input: JSON.stringify({ agent: "Helper", task: "Ask for budget" }),
    },
  ]);

  const alice = t.withIdentity({ subject: "alice" });

  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Go", requestKey: "child" }),
  );

  await drain(t);

  const runs = await alice.query(api.host.delegations, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 10 },
  });

  const childThreadId = runs.page[0].childThreadId!;
  const assignment = await t.query(managed.turns.send.assignment, { threadId: childThreadId });
  const childApproval = await approvalId(t, assignment!.assignmentId);

  // The host's approve action cannot bind consent to a child: `activity` is
  // root-only, so the whole action (including its respond) is refused.
  await expect(
    alice.mutation(api.host.approveContinue, {
      threadId: childThreadId,
      approvalId: childApproval,
    }),
  ).rejects.toThrow();

  expect(await consentRows(t)).toEqual([]);
  await drain(t);
  expect(child.calls).toHaveLength(1);

  // Answered through plain core respond instead, the tool refuses at execution.
  await alice.mutation(api.host.respond, {
    threadId: childThreadId,
    approvalId: childApproval,
    decision: { kind: "approve" as const },
  });

  await drain(t);
  // The approved child call returned the typed denial, not an approval.
  expect(child.calls).toHaveLength(2);
  const prompt = JSON.stringify(child.calls[1].prompt);

  expect(prompt).toContain("ROOT_ONLY");
  expect(prompt).not.toContain('"approved":true');
  expect(await consentRows(t)).toEqual([]);
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
  // The consent spend rolled back with everything else.
  expect(await consentRows(t)).toHaveLength(1);

  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "BUDGET_EXCEEDED",
  });

  await expect(resume(alice, receipt.threadId, approval)).resolves.toMatchObject({
    status: "resumed",
  });
});

it("a duplicate fresh request is never a successful resume: it throws and rolls back consent, raise and cancel", async () => {
  const t = setup();

  await limit(t, "alice", 1);
  state.steps.push(requestConsent("dup", { reason: "More" }));
  const alice = t.withIdentity({ subject: "alice" });

  const receipt = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Go", requestKey: "dup" }),
  );

  await drain(t);
  // While the approval is pending, an earlier request already used the exact
  // key and text this stop's resume will send (receipts are keyed by owner and
  // request key), so core answers the resume's send with `duplicate`.
  const { runId } = await alice.query(api.host.activity, { threadId: receipt.threadId });

  await alice.mutation(api.host.send, {
    threadId: receipt.threadId,
    text: CONSENT_TEXT,
    requestKey: `after-budget:${receipt.threadId}:${runId}`,
  });

  const approval = await approvalId(t, receipt.assignmentId);

  await alice.mutation(api.host.approveContinue, {
    threadId: receipt.threadId,
    approvalId: approval,
  });

  await drain(t);

  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    errorCode: "BUDGET_EXCEEDED",
  });

  await expect(resume(alice, receipt.threadId, approval)).rejects.toThrow("DUPLICATE_RESUME");
  expect((await budgetRows(t))[0].limit).toBe(1);
  expect(await consentRows(t)).toHaveLength(1);

  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "BUDGET_EXCEEDED",
  });
});

it("an approval recorded during an earlier run cannot resume a later run's stop", async () => {
  const t = setup();

  await limit(t, "alice", 1);
  const first = await stoppedForBudget(t, 2, "first");
  const r0 = state.budget.runIds[0];

  await resume(first.alice, first.receipt.threadId, first.approval);
  // The fresh run (R1) asks again; the user answers through core only, and a
  // consent row recorded for R0's approval time is all the host has.
  state.steps.push(requestConsent("consent-second", { reason: "Still need more" }));
  await drain(t);
  const second = await approvalId(t, first.receipt.assignmentId);

  await first.alice.mutation(api.host.respond, {
    threadId: first.receipt.threadId,
    approvalId: second,
    decision: { kind: "approve" as const },
  });

  await drain(t);

  await t.mutation(api.continueBudgetState.record, {
    subject: "alice",
    threadId: first.receipt.threadId,
    approvalId: second,
    runId: r0,
  });

  const { runId: r1 } = await first.alice.query(api.host.activity, {
    threadId: first.receipt.threadId,
  });

  expect(r1).not.toBe(r0);
  const before = (await budgetRows(t))[0].limit;

  await expect(resume(first.alice, first.receipt.threadId, second)).resolves.toEqual({
    status: "no-consent",
  });

  expect((await budgetRows(t))[0].limit).toBe(before);
  // The mismatched row is not spent.
  expect((await consentRows(t)).filter((row) => !row.spent)).toHaveLength(1);

  expect(
    await first.alice.query(api.host.activity, { threadId: first.receipt.threadId }),
  ).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "BUDGET_EXCEEDED",
  });
});
