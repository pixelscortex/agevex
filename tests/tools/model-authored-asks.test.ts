// @vitest-environment edge-runtime
// Model-authored forms cross the host/component seam as bounded per-call JSON.
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { createAskUserTool } from "../../src/modules/tools/registry/ask-user/askUser.js";
import { DECISION_LIMITS, type JsonSchema } from "../../src/shared/decisions.js";
import { main, helper } from "./fixture/host.js";
import { setup, api, state, child } from "./setup.js";
import { requireReceipt } from "../receipt.js";

const inputSchema = z.strictObject({
  question: z.string().trim(),
  questions: z
    .array(
      z.strictObject({
        id: z.string(),
        label: z.string().trim(),
        choices: z.array(z.string()).min(1).max(3),
      }),
    )
    .min(1)
    .max(3),
});

type Input = z.output<typeof inputSchema>;

const input: Input = {
  question: "Choose a plan",
  questions: [
    { id: "color", label: "Color", choices: ["green", "red"] },
    { id: "size", label: "Size", choices: ["small", "large"] },
    { id: "speed", label: "Speed", choices: ["fast", "slow"] },
  ],
};

const derive = (value: Input): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: value.questions.map((question) => question.id),
  properties: Object.fromEntries(
    value.questions.map((question) => [question.id, { type: "string", enum: question.choices }]),
  ),
});

const call = (id: string, value: unknown, toolName = "ask_human") => ({
  type: "tool-call" as const,
  toolName,
  toolCallId: id,
  input: JSON.stringify(value),
});

const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  delete main.declaredTools.ask_human;
  delete helper.declaredTools.ask_human;
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function open(t: ReturnType<typeof setup>) {
  const alice = t.withIdentity({ subject: "alice" });

  const receipt = requireReceipt(
    await alice.mutation(api.host.open, {
      agent: "Tools",
      prompt: "Ask for choices",
      requestKey: "form",
    }),
  );

  await drain(t);

  return {
    alice,
    receipt,
    pending: () =>
      alice.query(api.host.pendingApprovals, {
        threadId: receipt.threadId,
      }),
  };
}

it("three model-authored questions expose validated input and derived schema; invalid answers stay pending and valid answers resume once", async () => {
  const t = setup();
  const seen: Input[] = [];

  main.declaredTools.ask_human = createAskUserTool({
    inputSchema,
    answerSchema: (value) => {
      seen.push(value);

      return derive(value);
    },
  });

  state.steps.push([call("form", { ...input, question: ` ${input.question} ` })]);
  const { alice, receipt, pending } = await open(t);

  expect(seen).toEqual([input]);

  expect(await pending()).toMatchObject([
    {
      kind: "ask",
      tool: "ask_human",
      input,
      question: input.question,
      schema: derive(input),
    },
  ]);

  expect(
    JSON.stringify(state.calls[0].tools?.find((tool) => tool.name === "ask_human")),
  ).not.toContain('"enum"');

  const args = { threadId: receipt.threadId, toolCallId: "form" };

  // Answer validation uses the saved form even if the host registration changes.
  main.declaredTools.ask_human = createAskUserTool();

  await expect(
    alice.mutation(api.host.answer, {
      ...args,
      value: { color: "blue", size: "small", speed: "fast" },
    }),
  ).rejects.toThrow("INVALID_ANSWER");

  expect(await pending()).toHaveLength(1);
  expect(state.calls).toHaveLength(1);
  const value = { color: "green", size: "small", speed: "fast" };
  const answered = await alice.mutation(api.host.answer, { ...args, value });

  await drain(t);

  expect(await alice.mutation(api.host.answer, { ...args, value })).toEqual({
    ...answered,
    replayed: true,
  });

  await drain(t);
  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("green");
  expect(await pending()).toEqual([]);
});

it("two calls of the same ask tool retain their own derived answer schemas", async () => {
  const t = setup();

  main.declaredTools.ask_human = createAskUserTool({ inputSchema, answerSchema: derive });
  const second = { ...input, questions: [{ id: "mode", label: "Mode", choices: ["auto"] }] };

  state.steps.push([call("first", input), call("second", second)]);
  const { alice, receipt, pending } = await open(t);

  expect(await pending()).toMatchObject([
    { toolCallId: "first", input, schema: derive(input) },
    { toolCallId: "second", input: second, schema: derive(second) },
  ]);

  await expect(
    alice.mutation(api.host.answer, {
      threadId: receipt.threadId,
      toolCallId: "second",
      value: { color: "green" },
    }),
  ).rejects.toThrow("INVALID_ANSWER");
});

it("model input outside the custom schema or byte bound returns a tool error without a pending decision", async () => {
  const t = setup();
  const derived = vi.fn(derive);

  main.declaredTools.ask_human = createAskUserTool({ inputSchema, answerSchema: derived });

  const invalid = [
    { ...input, questions: [...input.questions, input.questions[0]] },
    { ...input, questions: [{ id: "color", label: "Color", choices: [42] }] },
    { ...input, question: "x".repeat(DECISION_LIMITS.valueBytes) },
  ];

  for (const [index, value] of invalid.entries())
    state.steps.push([call(`invalid-${index}`, value)]);

  const { alice, receipt, pending } = await open(t);

  expect(await pending()).toEqual([]);
  expect(derived).not.toHaveBeenCalled();
  expect(state.calls).toHaveLength(invalid.length + 1);
  expect(JSON.stringify(state.calls)).toContain("INVALID_QUESTION");

  expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    queuedMessages: 0,
  });
});

it.each([
  ["bytes", { type: "string", description: "x".repeat(DECISION_LIMITS.schemaBytes) }],
  ["unsupported keyword", { type: "string", pattern: ".*" }],
  [
    "field count",
    {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: DECISION_LIMITS.fields + 1 }, (_, index) => [
          index,
          { type: "string" },
        ]),
      ),
    },
  ],
  [
    "depth",
    Array.from({ length: DECISION_LIMITS.depth + 1 }).reduce<JsonSchema>(
      (items) => ({ type: "array", items }),
      { type: "string" },
    ),
  ],
  ["missing schema", undefined],
])(
  "invalid derived schema produces a typed tool error without failing the turn (%s)",
  async (_name, schema) => {
    const t = setup();

    main.declaredTools.ask_human = createAskUserTool({
      inputSchema,
      answerSchema: () => schema as JsonSchema,
    });

    state.steps.push([call("bad-form", input)]);
    const { alice, receipt, pending } = await open(t);

    expect(await pending()).toEqual([]);
    expect(state.calls).toHaveLength(2);
    expect(JSON.stringify(state.calls[1].prompt)).toContain("INVALID_FORM_SCHEMA");

    expect(await alice.query(api.host.activity, { threadId: receipt.threadId })).toMatchObject({
      turnStatus: "idle",
      errorCode: null,
    });
  },
);

it("validated Zod defaults and transforms are exposed in the pending input", async () => {
  const t = setup();

  main.declaredTools.ask_human = createAskUserTool({
    inputSchema: z.strictObject({
      label: z.string().trim(),
      choices: z.array(z.string()).default(["yes", "no"]),
    }),
    answerSchema: ({ choices }) => ({ type: "string", enum: choices }),
  });

  state.steps.push([call("defaults", { label: " Proceed? " })]);
  const { pending } = await open(t);

  expect(await pending()).toMatchObject([
    {
      input: { label: "Proceed?", choices: ["yes", "no"] },
      schema: { type: "string", enum: ["yes", "no"] },
    },
  ]);
});

it("a Zod default exceeding the input byte bound is a tool denial", async () => {
  const t = setup();

  main.declaredTools.ask_human = createAskUserTool({
    inputSchema: z.strictObject({
      text: z.string().default("x".repeat(DECISION_LIMITS.valueBytes)),
    }),
  });

  state.steps.push([call("large-default", {})]);
  const { pending } = await open(t);

  expect(await pending()).toEqual([]);
  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("INVALID_QUESTION");
});

it("non-idempotent Zod transforms derive the form from validated output without reparsing that output", async () => {
  const t = setup();

  main.declaredTools.ask_human = createAskUserTool({
    inputSchema: z.strictObject({ count: z.string().transform((value) => Number(value) + 1) }),
    answerSchema: ({ count }) => ({ type: "integer", minimum: count, maximum: count }),
  });

  state.steps.push([call("transform", { count: "2" })]);
  const { pending } = await open(t);

  expect(await pending()).toMatchObject([
    {
      input: { count: 3 },
      schema: { type: "integer", minimum: 3, maximum: 3 },
    },
  ]);
});

it("JSON input schemas validate calls and derive a stored answer form", async () => {
  const t = setup();

  main.declaredTools.ask_human = createAskUserTool<{ choices: string[] }>({
    inputSchema: {
      type: "object",
      required: ["choices"],
      additionalProperties: false,
      properties: { choices: { type: "array", maxItems: 3, items: { type: "string" } } },
    },
    answerSchema: ({ choices }) => ({ type: "string", enum: choices }),
  });

  state.steps.push([call("bad-json", { choices: [1] })], [call("json", { choices: ["a", "b"] })]);
  const { pending } = await open(t);

  expect(await pending()).toMatchObject([
    {
      input: { choices: ["a", "b"] },
      schema: { type: "string", enum: ["a", "b"] },
    },
  ]);

  expect(state.calls).toHaveLength(2);
});

it("a child without askUser permission cannot pause with a custom ask marker under another key", async () => {
  const t = setup();

  helper.declaredTools.ask_human = createAskUserTool({ inputSchema, answerSchema: derive });
  child.steps = [[call("child-form", input)]];
  state.steps.push([call("delegate", { agent: "Helper", task: "Work" }, "agevex_delegate")]);
  const { pending } = await open(t);

  expect(await pending()).toEqual([]);
  expect(JSON.stringify(child.calls)).toContain("ROOT_ONLY");
});

it("custom input and schema that exceed the pending item budget project a bounded stub", async () => {
  const t = setup();

  main.declaredTools.ask_human = createAskUserTool({
    inputSchema: z.strictObject({ text: z.string() }),
    answerSchema: () => ({ type: "string", description: "s".repeat(7 << 10) }),
  });

  state.steps.push([call("large", { text: "x".repeat(10 << 10) })]);
  const { pending } = await open(t);

  expect(await pending()).toMatchObject([{ truncated: true, input: null, editable: false }]);
  expect((await pending())[0].schema).toBeUndefined();
});
