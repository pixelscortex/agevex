// @vitest-environment edge-runtime
// Human decisions exercise native fake-model pauses, receipts, fences and continuation.
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createAskUserTool } from "../../src/modules/tools/registry/ask-user/askUser.js";
import { assertFormSchema, type Decision, type JsonSchema } from "../../src/shared/decisions.js";
import { setup, api, native, state, child } from "./setup.js";
import { main } from "./fixture/host.js";
import { rawAssignment } from "../fixture/api.js";
import { fingerprint } from "../../src/client/keys.js";
import { requireReceipt } from "../receipt.js";
import type { LanguageModelV4Content } from "@ai-sdk/provider";

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
  ).rejects.toThrow("FORBIDDEN");

  await expect(
    t
      .withIdentity({ subject: "alice" })
      .query(api.host.pendingApprovals, { threadId: receipt.threadId, rootRunId: "foreign" }),
  ).rejects.toThrow();
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
