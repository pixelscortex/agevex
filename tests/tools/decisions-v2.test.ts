// @vitest-environment edge-runtime
// Human decisions exercise native fake-model pauses, receipts, fences and continuation.
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createAskUserTool } from "../../src/modules/tools/registry/ask-user/askUser.js";
import {
  assertFormSchema,
  DECISION_LIMITS,
  type Decision,
  type JsonSchema,
} from "../../src/shared/decisions.js";
import { setup, api, native, state, child } from "./setup.js";
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import { main, helper } from "./fixture/host.js";
import { rawAssignment } from "../fixture/api.js";
import { fingerprint } from "../../src/client/keys.js";
import { LIMITS } from "../../src/component/limits.js";
import { requireReceipt } from "../receipt.js";
import type { LanguageModelV4Content } from "@ai-sdk/provider";

const editableEcho = main.declaredTools.editable_echo;

const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));

const call = (name: string, id: string, input: unknown): LanguageModelV4Content[] => [
  { type: "tool-call", toolName: name, toolCallId: id, input: JSON.stringify(input) },
];

const schema: JsonSchema = {
  type: "object",
  required: ["color", "count"],
  additionalProperties: false,
  properties: {
    color: { type: "string", enum: ["green", "red"] },
    count: { type: "integer", minimum: 1 },
    rows: { type: "array", items: { type: "boolean" }, maxItems: 3 },
  },
};

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  main.declaredTools.ask_user = createAskUserTool();
  main.declaredTools.editable_echo = editableEcho;

  for (const name of ["plain_echo", "date", "large_question", "ask_human"])
    delete main.declaredTools[name];

  delete helper.declaredTools.ask_human;
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function open(t: ReturnType<typeof setup>, agent = "Tools") {
  const receipt = requireReceipt(
    await t
      .withIdentity({ subject: "alice" })
      .mutation(api.host.open, { agent, prompt: "Do the work", requestKey: "work" }),
  );

  await drain(t);

  return receipt;
}

async function approval(t: ReturnType<typeof setup>) {
  state.steps.push(call("editable_echo", "effect-1", { text: "original" }));
  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const [pending] = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });

  expect(pending).toMatchObject({ kind: "approval", editable: true, input: { text: "original" } });

  return { alice, receipt, args: { threadId: receipt.threadId, approvalId: pending.id } };
}

it("edited approval executes only validated effective input and records the exact input in native history", async () => {
  const t = setup();
  const { alice, receipt, args } = await approval(t);
  const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });
  const sourceId = row!.approvals!.requests[0].messageId;
  const decision: Decision = { kind: "approve", edit: { input: { text: "owner correction" } } };
  const result = await alice.mutation(api.host.respond, { ...args, decision });

  const [response] = await t.query(native.messages.getMessagesByIds, {
    messageIds: [result.messageId],
  });

  expect(JSON.stringify(response?.message)).toContain("owner correction");
  const [proposal] = await t.query(native.messages.getMessagesByIds, { messageIds: [sourceId] });

  expect(proposal?.message).toMatchObject({
    role: "assistant",
    content: [
      { type: "tool-call", input: { text: "original" } },
      { type: "tool-approval-request" },
    ],
  });

  expect(JSON.stringify(response?.message)).toContain(
    await fingerprint({ text: "owner correction" }),
  );

  await drain(t);
  expect(state.effects).toEqual(["owner correction"]);
  expect(state.hookInputs).toEqual([{ text: "owner correction" }]);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("effectiveHash");
  expect(JSON.stringify(state.calls[1].prompt)).toContain("owner correction");
  expect(await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId })).toEqual([]);

  expect(await alice.mutation(api.host.respond, { ...args, decision })).toEqual({
    ...result,
    replayed: true,
  });

  await drain(t);
  expect(state.effects).toHaveLength(1);
});

it("invalid edits leave the decision pending and perform no effect", async () => {
  const t = setup();
  const { alice, receipt, args } = await approval(t);

  for (const input of [
    { text: 2 },
    { wrong: "field" },
    { text: "" },
    { text: "x".repeat(16 << 10) },
  ])
    await expect(
      alice.mutation(api.host.respond, { ...args, decision: { kind: "approve", edit: { input } } }),
    ).rejects.toThrow();

  expect(state.effects).toEqual([]);

  expect(await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId })).toHaveLength(
    1,
  );

  await alice.mutation(api.host.respond, { ...args, decision: { kind: "approve" } });
  await drain(t);
  expect(state.effects).toEqual(["original"]);
});

it.each<Decision>([
  { kind: "approve" },
  { kind: "reject", reason: "No" },
  { kind: "approve", edit: { input: { text: "edited" } } },
])(
  "decision replay preserves the first $kind decision and changed payloads conflict",
  async (decision) => {
    const t = setup();
    const { alice, args } = await approval(t);
    const result = await alice.mutation(api.host.respond, { ...args, decision });

    await drain(t);

    expect(await alice.mutation(api.host.respond, { ...args, decision })).toEqual({
      ...result,
      replayed: true,
    });

    await expect(
      alice.mutation(api.host.respond, {
        ...args,
        decision: { kind: "reject", reason: "changed" },
      }),
    ).rejects.toMatchObject({ data: { code: "KEY_CONFLICT" } });

    expect(state.effects).toHaveLength(decision.kind === "reject" ? 0 : 1);
  },
);

it.each(["rewrite", "mutate", "block"])(
  "beforeTool cannot change approved work (%s)",
  async (mode) => {
    const t = setup();
    const { alice, args } = await approval(t);

    state.rewrite = mode === "rewrite" ? true : mode === "mutate" ? "mutate" : "block";

    await alice.mutation(api.host.respond, {
      ...args,
      decision: { kind: "approve", edit: { input: { text: "approved" } } },
    });

    await drain(t);
    expect(state.effects).toEqual([]);

    expect(JSON.stringify(state.calls[1].prompt)).toContain(
      mode === "block" ? "HOOK_BLOCKED" : "APPROVED_INPUT_CHANGED",
    );
  },
);

it("cancel fences an approved edit before it can execute", async () => {
  const t = setup();
  const { alice, receipt, args } = await approval(t);

  await alice.mutation(api.host.respond, {
    ...args,
    decision: { kind: "approve", edit: { input: { text: "approved" } } },
  });

  await alice.mutation(api.host.cancel, { threadId: receipt.threadId });
  await drain(t);
  expect(state.effects).toEqual([]);
});

it("structured answers validate recorded form metadata without coercion and malformed answers remain pending", async () => {
  const t = setup();

  main.declaredTools.ask_user = createAskUserTool({ answerSchema: schema });
  state.steps.push(call("ask_user", "form-1", { question: "Choose settings" }));
  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const args = { threadId: receipt.threadId, toolCallId: "form-1" };

  expect(
    await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId }),
  ).toMatchObject([{ kind: "ask", schema, question: "Choose settings", editable: false }]);

  // Changing today's registration must not change the schema already shown to the owner.
  main.declaredTools.ask_user = createAskUserTool();

  for (const value of [
    "green",
    { color: "blue", count: 1 },
    { color: "green", count: "1" },
    { color: "green", count: 1, rows: [1] },
    { color: "green", count: 0 },
    { count: 2 },
  ])
    await expect(alice.mutation(api.host.answer, { ...args, value })).rejects.toThrow(
      "INVALID_ANSWER",
    );

  expect(state.calls).toHaveLength(1);

  expect(await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId })).toHaveLength(
    1,
  );

  const value = { color: "green", count: 2, rows: [true, false] };
  const result = await alice.mutation(api.host.answer, { ...args, value });

  const [message] = await t.query(native.messages.getMessagesByIds, {
    messageIds: [result.messageId],
  });

  expect(message?.message).toMatchObject({
    role: "tool",
    content: [{ output: { type: "json", value } }],
  });

  await drain(t);
  expect(state.calls).toHaveLength(2);

  expect(
    await alice.mutation(api.host.answer, {
      ...args,
      value: { rows: [true, false], count: 2, color: "green" },
    }),
  ).toEqual({
    ...result,
    replayed: true,
  });

  await expect(
    alice.mutation(api.host.answer, { ...args, value: { ...value, count: 3 } }),
  ).rejects.toThrow("KEY_CONFLICT");
});

it.each([undefined, true, false])(
  "shared agents enforce persisted child ask_user policy (%s) and permitted children resume",
  async (askUser) => {
    const t = setup();

    child.askUser = askUser;
    child.steps = [call("ask_user", "child-ask", { question: "May I proceed?" })];
    state.steps.push(call("agevex_delegate", "delegate-1", { agent: "Helper", task: "Work" }));
    const receipt = await open(t);
    const alice = t.withIdentity({ subject: "alice" });
    const pending = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });

    if (askUser === true) {
      expect(pending).toMatchObject([{ toolCallId: "child-ask", agent: "Helper", kind: "ask" }]);

      child.askUser = false; // The existing run retains its captured permission.

      await alice.mutation(api.host.answer, {
        threadId: pending[0].threadId,
        toolCallId: "child-ask",
        value: "Proceed",
      });

      await drain(t);
    } else {
      expect(pending).toEqual([]);
      expect(JSON.stringify(child.calls)).toContain("ROOT_ONLY");
    }

    const runs = await alice.query(api.host.delegations, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(runs.page[0].status).toBe("completed");
  },
);

it("a shared Agent acting as root can ask by default", async () => {
  const t = setup();

  child.steps = [call("ask_user", "root-ask", { question: "Proceed?" })];
  const receipt = await open(t, "Helper");
  const alice = t.withIdentity({ subject: "alice" });

  expect(
    await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId }),
  ).toMatchObject([{ toolCallId: "root-ask" }]);

  await alice.mutation(api.host.answer, {
    threadId: receipt.threadId,
    toolCallId: "root-ask",
    value: "Yes",
  });

  await drain(t);
  expect(child.calls).toHaveLength(2);
});

it("pending queries authorize the root and reject foreign run selectors", async () => {
  const t = setup();
  const { receipt } = await approval(t);

  await expect(
    t
      .withIdentity({ subject: "bob" })
      .query(api.host.pendingApprovals, { threadId: receipt.threadId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });

  await expect(
    t
      .withIdentity({ subject: "alice" })
      .query(api.host.pendingApprovals, { threadId: receipt.threadId, rootRunId: "foreign" }),
  ).rejects.toMatchObject({ data: { code: "RUN_NOT_FOUND" } });
});

it("form schemas reject remote references, excess depth and unvalidated constraints", () => {
  let deep: JsonSchema = { type: "string" };

  for (let depth = 0; depth < 10; depth++) deep = { type: "array", items: deep };

  expect(() => createAskUserTool({ answerSchema: deep })).toThrow();

  expect(() =>
    createAskUserTool({ answerSchema: { type: "string", description: "x".repeat(8 << 10) } }),
  ).toThrow();

  for (const bad of [
    { type: "string", $ref: "https://example.org/schema" },
    { type: "string", pattern: ".*" },
    {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i, { type: "string" }])),
    },
  ])
    expect(() => assertFormSchema(bad as JsonSchema)).toThrow();
});

it("an explicit false policy denies ask_user for a root without a human pause", async () => {
  const t = setup();

  child.askUser = false;
  child.steps = [call("ask_user", "root-denied", { question: "May I?" })];
  const receipt = await open(t, "Helper");

  expect(
    await t
      .withIdentity({ subject: "alice" })
      .query(api.host.pendingApprovals, { threadId: receipt.threadId }),
  ).toEqual([]);

  expect(JSON.stringify(child.calls)).toContain("ROOT_ONLY");
});

it("plain needsApproval tools refuse edits and remain approvable without opting into editing", async () => {
  const t = setup();

  main.declaredTools.plain_echo = tool({
    inputSchema: z.object({ text: z.string() }),
    needsApproval: true,
    execute: ({ text }) => {
      state.effects.push(text);

      return text;
    },
  });

  state.steps.push(call("plain_echo", "plain-1", { text: "original" }));
  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const [pending] = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });

  expect(pending.editable).toBe(false);

  await expect(
    alice.mutation(api.host.respond, {
      threadId: receipt.threadId,
      approvalId: pending.id,
      decision: { kind: "approve", edit: { input: { text: "changed" } } },
    }),
  ).rejects.toMatchObject({ data: { code: "APPROVAL_NOT_EDITABLE" } });

  expect(await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId })).toHaveLength(
    1,
  );

  await alice.mutation(api.host.respond, {
    threadId: receipt.threadId,
    approvalId: pending.id,
    decision: { kind: "approve" },
  });

  await drain(t);
  expect(state.effects).toEqual(["original"]);
});

it("plain approval accepts Date coercion without validating or serialising its parsed schema output", async () => {
  const t = setup();

  // Seed a native JSON proposal; z.coerce.date has no JSON Schema export.
  main.declaredTools.date = tool({
    inputSchema: z.object({ when: z.string() }),
    needsApproval: true,
    execute: () => "done",
  });

  state.steps.push(call("date", "date-1", { when: "2026-10-01" }));
  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const [pending] = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });

  main.declaredTools.date = tool({
    inputSchema: z.object({ when: z.coerce.date() }),
    needsApproval: true,
    execute: () => "done",
  });

  const response = await alice.mutation(api.host.respond, {
    threadId: receipt.threadId,
    approvalId: pending.id,
    decision: { kind: "approve" },
  });

  expect(response.replayed).toBe(false);

  const [saved] = await t.query(native.messages.getMessagesByIds, {
    messageIds: [response.messageId],
  });

  expect(saved?.message).toMatchObject({
    role: "tool",
    content: [{ type: "tool-approval-response", approved: true }],
  });

  await alice.mutation(api.host.cancel, { threadId: receipt.threadId });
  await drain(t);
});

it("a 20 KiB reasoning step remains pending and approves without another model call before execution", async () => {
  const t = setup();

  state.steps.push([
    { type: "reasoning", text: "r".repeat(20 << 10) },
    ...call("editable_echo", "large-reasoning", { text: "original" }),
  ]);

  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const [pending] = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });

  expect(pending).toMatchObject({ input: { text: "original" }, editable: true });
  expect(state.calls).toHaveLength(1);

  await alice.mutation(api.host.respond, {
    threadId: receipt.threadId,
    approvalId: pending.id,
    decision: { kind: "approve", edit: { input: { text: "approved" } } },
  });

  await drain(t);
  expect(state.effects).toEqual(["approved"]);
});

it("oversized pending input commits typed APPROVAL_LIMIT instead of GENERATION_FAILED", async () => {
  const t = setup();

  state.steps.push(call("editable_echo", "too-large", { text: "x".repeat(17 << 10) }));
  const receipt = await open(t);

  expect(await t.query(rawAssignment, { assignmentId: receipt.assignmentId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "APPROVAL_LIMIT",
  });

  expect(state.effects).toEqual([]);

  expect(
    await t.withIdentity({ subject: "alice" }).query(api.host.pendingApprovals, {
      threadId: receipt.threadId,
    }),
  ).toEqual([]);
});

it("ordinary approval questions are not duplicated in the pending projection", async () => {
  const t = setup();

  main.declaredTools.plain_echo = tool({
    inputSchema: z.object({ question: z.string() }),
    needsApproval: true,
    execute: () => "done",
  });

  state.steps.push([
    ...call("plain_echo", "large-approval", { question: "q".repeat(15 << 10) }),
    ...call("editable_echo", "small-approval", { text: "ok" }),
  ]);

  const receipt = await open(t);

  const pending = await t.withIdentity({ subject: "alice" }).query(api.host.pendingApprovals, {
    threadId: receipt.threadId,
  });

  expect(pending).toHaveLength(2);
  expect(pending.find((item) => item.tool === "plain_echo")).not.toHaveProperty("question");

  expect(pending.find((item) => item.tool === "plain_echo")?.input).toEqual({
    question: "q".repeat(15 << 10),
  });

  expect(pending.find((item) => item.tool === "editable_echo")?.editable).toBe(true);
});

it("a no-execute tool whose pending item cannot fit is refused before saving, and a fitting one is answerable", async () => {
  const t = setup();

  main.declaredTools.large_question = tool({ inputSchema: z.object({ question: z.string() }) });

  // The input alone fits the 16 KiB input limit, but its pending item (with
  // identifiers and envelope) would not: it must never be saved as a stub.
  state.steps.push(call("large_question", "large-ask", { question: "q".repeat(16300) }));
  const refused = await open(t);

  expect(await t.query(rawAssignment, { assignmentId: refused.assignmentId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "APPROVAL_LIMIT",
  });

  const alice = t.withIdentity({ subject: "alice" });

  expect(await alice.query(api.host.pendingApprovals, { threadId: refused.threadId })).toEqual([]);

  state.steps.push(call("large_question", "fits", { question: "q".repeat(10 << 10) }));

  const accepted = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "Again", requestKey: "again" }),
  );

  await drain(t);
  const [item] = await alice.query(api.host.pendingApprovals, { threadId: accepted.threadId });

  expect(item).toMatchObject({ toolCallId: "fits", kind: "ask" });
  expect(item.truncated).toBeUndefined();

  await alice.mutation(api.host.answer, {
    threadId: accepted.threadId,
    toolCallId: "fits",
    value: "ok",
  });
});

it("two clients deciding concurrently commit one decision and reject the losing payload", async () => {
  const t = setup();
  const { alice, receipt, args } = await approval(t);
  const otherClient = t.withIdentity({ subject: "alice" });

  const outcomes = await Promise.allSettled([
    alice.mutation(api.host.respond, {
      ...args,
      decision: { kind: "approve", edit: { input: { text: "first" } } },
    }),
    otherClient.mutation(api.host.respond, {
      ...args,
      decision: { kind: "approve", edit: { input: { text: "second" } } },
    }),
  ]);

  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);

  expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
    reason: { data: { code: "KEY_CONFLICT" } },
  });

  await drain(t);
  expect(state.effects).toHaveLength(1);
  expect(["first", "second"]).toContain(state.effects[0]);
  expect(await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId })).toEqual([]);
});

it("ask_user registered as ask_human validates its captured schema without exposing it to the model", async () => {
  const t = setup();

  main.declaredTools.ask_human = createAskUserTool({ answerSchema: schema });
  state.steps.push(call("ask_human", "alias-form", { question: "Choose settings" }));
  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const [pending] = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });

  expect(pending).toMatchObject({ tool: "ask_human", schema, question: "Choose settings" });

  await expect(
    alice.mutation(api.host.answer, {
      threadId: receipt.threadId,
      toolCallId: "alias-form",
      value: "bad",
    }),
  ).rejects.toMatchObject({ data: { code: "INVALID_ANSWER" } });

  main.declaredTools.ask_human = createAskUserTool();

  await alice.mutation(api.host.answer, {
    threadId: receipt.threadId,
    toolCallId: "alias-form",
    value: { color: "red", count: 1 },
  });

  await drain(t);
  expect(JSON.stringify(state.calls[1].prompt)).not.toContain("agevexAnswerSchema");
  expect(JSON.stringify(state.calls[1].prompt)).not.toContain("additionalProperties");
});

it("ask_user registered as ask_human still enforces the default child ROOT_ONLY policy", async () => {
  const t = setup();

  helper.declaredTools.ask_human = createAskUserTool({ answerSchema: schema });
  child.steps = [call("ask_human", "alias-child", { question: "May I?" })];
  state.steps.push(call("agevex_delegate", "alias-delegate", { agent: "Helper", task: "Work" }));
  const receipt = await open(t);

  expect(
    await t.withIdentity({ subject: "alice" }).query(api.host.pendingApprovals, {
      threadId: receipt.threadId,
    }),
  ).toEqual([]);

  expect(JSON.stringify(child.calls)).toContain("ROOT_ONLY");
});

it("approved tools without schema validate cannot have their input rewritten by hooks", async () => {
  const t = setup();

  main.declaredTools.editable_echo = tool({
    inputSchema: jsonSchema<{ text: string }>({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    }),
    needsApproval: true,
    execute: ({ text }) => {
      state.effects.push(text);

      return text;
    },
  });

  state.steps.push(call("editable_echo", "no-validate", { text: "original" }));
  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const [pending] = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });

  state.rewrite = true;

  await alice.mutation(api.host.respond, {
    threadId: receipt.threadId,
    approvalId: pending.id,
    decision: { kind: "approve" },
  });

  await drain(t);
  expect(state.effects).toEqual([]);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("APPROVED_INPUT_CHANGED");
});

it("an approved call still executes its approved input after a sibling stays undecided past receipt retention", async () => {
  const t = setup();

  state.steps.push([
    ...call("editable_echo", "call-a", { text: "a-original" }),
    ...call("editable_echo", "call-b", { text: "b-original" }),
  ]);

  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const pending = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });
  const idOf = (toolCallId: string) => pending.find((item) => item.toolCallId === toolCallId)!.id;

  await alice.mutation(api.host.respond, {
    threadId: receipt.threadId,
    approvalId: idOf("call-a"),
    decision: { kind: "approve", edit: { input: { text: "a-edited" } } },
  });

  // Past the 7-day effect-receipt retention, with the purge chain run.
  vi.advanceTimersByTime(LIMITS.receiptRetentionMs + LIMITS.purgeIntervalMs);
  await drain(t);
  expect(state.effects).toEqual([]);

  expect(await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId })).toHaveLength(
    1,
  );

  await alice.mutation(api.host.respond, {
    threadId: receipt.threadId,
    approvalId: idOf("call-b"),
    decision: { kind: "approve" },
  });

  await drain(t);
  expect([...state.effects].sort()).toEqual(["a-edited", "b-original"]);
  expect(JSON.stringify(state.calls[1].prompt)).not.toContain("APPROVED_INPUT_GONE");
});

it("a truncated approval refuses edits with PROPOSAL_TRUNCATED and stays pending", async () => {
  const t = setup();

  state.steps.push(
    call("editable_echo", "e".repeat(DECISION_LIMITS.identifierChars + 1), { text: "original" }),
  );

  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const pending = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });

  expect(pending).toHaveLength(1);
  expect(pending[0].truncated).toBe(true);

  await expect(
    alice.mutation(api.host.respond, {
      threadId: receipt.threadId,
      approvalId: pending[0].id,
      decision: { kind: "approve", edit: { input: { text: "changed" } } },
    }),
  ).rejects.toMatchObject({ data: { code: "PROPOSAL_TRUNCATED" } });

  expect(await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId })).toHaveLength(
    1,
  );

  expect(state.effects).toEqual([]);
  await alice.mutation(api.host.cancel, { threadId: receipt.threadId });
  await drain(t);
});

it("a factory ask call with an identifier over the limit is denied before saving and the model continues", async () => {
  const t = setup();
  const id = "f".repeat(DECISION_LIMITS.identifierChars + 1);

  main.declaredTools.ask_user = createAskUserTool({ answerSchema: schema });
  state.steps.push(call("ask_user", id, { question: "Choose settings" }));
  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });

  expect(await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId })).toEqual([]);
  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("ASK_TOO_LARGE");
});

it("a no-execute call with an identifier over the limit is refused with APPROVAL_LIMIT instead of becoming an unanswerable stub", async () => {
  const t = setup();
  const id = "f".repeat(DECISION_LIMITS.identifierChars + 1);

  main.declaredTools.large_question = tool({ inputSchema: z.object({ question: z.string() }) });
  state.steps.push(call("large_question", id, { question: "Choose settings" }));
  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });

  expect(await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId })).toEqual([]);

  expect(await t.query(rawAssignment, { assignmentId: receipt.assignmentId })).toMatchObject({
    errorCode: "APPROVAL_LIMIT",
  });
});

it("an ask with a long question and a large form schema appears in full without a duplicated input", async () => {
  const t = setup();
  // 2000 three-byte chars: ~6 KB, so question + copy + schema would exceed 16 KiB.
  const question = "\u20ac".repeat(2000);

  const big: JsonSchema = {
    type: "object",
    description: "d".repeat(7 << 10),
    properties: { ok: { type: "boolean" } },
  };

  main.declaredTools.ask_user = createAskUserTool({ answerSchema: big });
  state.steps.push(call("ask_user", "big-ask", { question }));
  const receipt = await open(t);
  const alice = t.withIdentity({ subject: "alice" });
  const [item] = await alice.query(api.host.pendingApprovals, { threadId: receipt.threadId });

  expect(item).toMatchObject({ kind: "ask", question, schema: big, editable: false });
  expect(item.truncated).toBeUndefined();
  expect(item.input).toBeNull();

  await alice.mutation(api.host.answer, {
    threadId: receipt.threadId,
    toolCallId: "big-ask",
    value: { ok: true },
  });

  await drain(t);
  expect(state.calls).toHaveLength(2);
});
