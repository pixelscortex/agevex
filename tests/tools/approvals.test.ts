// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setup, api, native, managed, state } from "./setup.js";
import { ASK_USER_LIMITS } from "../../docs/site/registry/ask-user/askUser.js";
import { CONTINUE_BUDGET_LIMITS } from "../../docs/site/registry/continue-budget/continueBudget.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
const cases = [
  { tool: "ask_user", field: "question", max: ASK_USER_LIMITS.questionChars },
  { tool: "continue_budget", field: "reason", max: CONTINUE_BUDGET_LIMITS.reasonChars },
] as const;

it.each(cases)(
  "$tool pauses at its hard maximum, authorizes the responder, and resumes once through core respond",
  async ({ tool, field, max }) => {
    const t = setup();
    const text = "界".repeat(max);
    state.steps.push([
      {
        type: "tool-call",
        toolName: tool,
        toolCallId: "approval-call",
        input: JSON.stringify({ [field]: text }),
      },
    ]);
    const alice = t.withIdentity({ subject: "alice" });
    const receipt = await alice.mutation(api.host.open, {
      agent: "Tools",
      prompt: "Ask for approval",
      requestKey: tool,
    });
    await drain(t);
    expect(state.calls).toHaveLength(1);
    const execution = await t.query(managed.queue.execution, {
      assignmentId: receipt.assignmentId,
    });
    expect(execution?.approvalBlocked).toBe(true);
    const requests = execution?.approvals?.requests;
    expect(requests).toHaveLength(1);
    // Read only the exact id core recorded in the transaction that saved it.
    const [request] = await t.query(native.messages.getMessagesByIds, {
      messageIds: [requests![0].messageId],
    });
    const parts = request?.message?.content;
    const approval = Array.isArray(parts)
      ? parts.find((part) => part.type === "tool-approval-request")
      : undefined;
    if (approval?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");
    const response = {
      threadId: receipt.threadId,
      approvalId: approval.approvalId,
      approved: true,
      reason: "Use the smaller plan.",
    };
    await expect(
      t.withIdentity({ subject: "bob" }).mutation(api.host.respond, response),
    ).rejects.toThrow();
    expect(state.calls).toHaveLength(1);
    const answered = await alice.mutation(api.host.respond, response);
    const [answer] = await t.query(native.messages.getMessagesByIds, {
      messageIds: [answered.messageId],
    });
    expect(answer?.message?.content).toContainEqual({
      type: "tool-approval-response",
      approvalId: approval.approvalId,
      approved: true,
      reason: response.reason,
    });
    await expect(alice.mutation(api.host.respond, response)).rejects.toThrow();
    await drain(t);
    expect(state.calls).toHaveLength(2);
    expect(JSON.stringify(state.calls[1].prompt)).toContain('"approved":true');
    expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
      turnStatus: "idle",
    });
    expect(await t.run((ctx) => ctx.db.query("agevexTodos").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("agevexGoals").collect())).toEqual([]);
  },
);

it.each(cases)(
  "$tool denial resumes without an approved tool execution",
  async ({ tool, field }) => {
    const t = setup();
    state.steps.push([
      {
        type: "tool-call",
        toolName: tool,
        toolCallId: "denied-call",
        input: JSON.stringify({ [field]: "Continue?" }),
      },
    ]);
    const alice = t.withIdentity({ subject: "alice" });
    const receipt = await alice.mutation(api.host.open, {
      agent: "Tools",
      prompt: "Ask",
      requestKey: "deny",
    });
    await drain(t);
    const execution = await t.query(managed.queue.execution, {
      assignmentId: receipt.assignmentId,
    });
    const [request] = await t.query(native.messages.getMessagesByIds, {
      messageIds: [execution!.approvals!.requests[0].messageId],
    });
    const content = request?.message?.content;
    const approval = Array.isArray(content)
      ? content.find((part) => part.type === "tool-approval-request")
      : undefined;
    if (approval?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");
    await alice.mutation(api.host.respond, {
      threadId: receipt.threadId,
      approvalId: approval.approvalId,
      approved: false,
      reason: "Stop here.",
    });
    await drain(t);
    expect(state.calls).toHaveLength(2);
    const prompt = JSON.stringify(state.calls[1].prompt);
    expect(prompt).toContain("Stop here.");
    expect(prompt).toContain("execution-denied");
    expect(prompt).not.toContain('"approved":true');
  },
);

it.each(cases)(
  "$tool rejects blank, oversized and model-supplied ownership before asking the user",
  async ({ tool, field, max }) => {
    const t = setup();
    for (const [index, input] of [
      { [field]: "   " },
      { [field]: "x".repeat(max + 1) },
      { [field]: "Can I?", subject: "bob", threadId: "foreign" },
    ].entries()) {
      state.steps.push([
        {
          type: "tool-call",
          toolName: tool,
          toolCallId: `invalid-${index}`,
          input: JSON.stringify(input),
        },
      ]);
    }
    const alice = t.withIdentity({ subject: "alice" });
    const receipt = await alice.mutation(api.host.open, {
      agent: "Tools",
      prompt: "Ask",
      requestKey: "invalid",
    });
    await drain(t);
    expect(state.calls).toHaveLength(4);
    const execution = await t.query(managed.queue.execution, {
      assignmentId: receipt.assignmentId,
    });
    expect(execution?.approvalBlocked).not.toBe(true);
    expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
      turnStatus: "idle",
    });
  },
);
