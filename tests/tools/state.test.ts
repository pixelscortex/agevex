// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { setup, api, state } from "./setup.js";
import { LIMITS } from "../../src/client/index.js";
import { requireReceipt } from "../receipt.js";
import { TODO_LIMITS } from "../../src/modules/tools/registry/todo/todo.js";
import { GOAL_LIMITS } from "../../src/modules/tools/registry/goals/goals.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));

const call = (toolName: string, toolCallId: string, input: unknown): LanguageModelV4Content[] => [
  {
    type: "tool-call",
    toolName,
    toolCallId,
    input: JSON.stringify(input),
  },
];

const todo = (text = "Write the guide") => ({ id: "guide", text, done: false });

const open = async (t: ReturnType<typeof setup>, requestKey = "first", subject = "alice") =>
  requireReceipt(
    await t
      .withIdentity({ subject })
      .mutation(api.host.open, { agent: "Tools", prompt: "Use the tools", requestKey }),
  );

function maximumTodos() {
  const todos = Array.from({ length: TODO_LIMITS.items }, (_, i) => ({
    id: String(i),
    text: "x",
    done: false,
  }));

  let remaining =
    TODO_LIMITS.listBytes - new TextEncoder().encode(JSON.stringify(todos)).byteLength;

  for (const item of todos) {
    const extra = Math.min(remaining, TODO_LIMITS.textChars - item.text.length);

    item.text += "x".repeat(extra);
    remaining -= extra;
  }

  expect(remaining).toBe(0);

  return todos;
}

it("todo tools persist across calls and reads, isolate owners and threads, and replay old writes without overwriting newer state", async () => {
  const t = setup();

  state.steps.push(
    call("todo_write", "original-write", { todos: [todo("original")] }),
    call("todo_write", "newer-write", { todos: [todo("newer")] }),
    call("todo_write", "original-write", { todos: [todo("original")] }),
    call("todo_read", "read", {}),
  );

  const receipt = await open(t);

  await drain(t);
  const scope = { subject: "alice", threadId: receipt.threadId };

  expect(await t.query(api.todoState.read, scope)).toEqual({ todos: [todo("newer")] });
  expect(JSON.stringify(state.calls[state.calls.length - 1]?.prompt)).toContain('"text":"newer"');
  expect(await t.query(api.todoState.read, { ...scope, subject: "bob" })).toEqual({ todos: [] });

  expect(await t.query(api.todoState.read, { ...scope, threadId: "another" })).toEqual({
    todos: [],
  });

  await expect(
    t.withIdentity({ subject: "bob" }).query(api.host.messages, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  ).rejects.toThrow();

  state.steps.length = state.calls.length;
  state.steps.push(call("todo_read", "next-turn-read", {}));

  await t.withIdentity({ subject: "alice" }).mutation(api.host.send, {
    threadId: receipt.threadId,
    text: "Read it again",
    requestKey: "second",
  });

  await drain(t);
  expect(JSON.stringify(state.calls[state.calls.length - 1]?.prompt)).toContain('"text":"newer"');
});

it("goal tools replay idempotently, return the thread's current goal, and isolate owners and threads", async () => {
  const t = setup();

  state.steps.push(
    call("goal_set", "original-goal", { goal: "original" }),
    call("goal_set", "newer-goal", { goal: "newer" }),
    call("goal_set", "original-goal", { goal: "original" }),
    call("goal_check", "check", {}),
  );

  const receipt = await open(t);

  await drain(t);
  const rows = await t.run((ctx) => ctx.db.query("agevexGoals").collect());

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ subject: "alice", threadId: receipt.threadId, goal: "newer" });
  const scope = { subject: "alice", threadId: receipt.threadId };

  expect(await t.query(api.goalsState.check, scope)).toEqual({ goal: "newer" });
  expect(await t.query(api.goalsState.check, { ...scope, subject: "bob" })).toEqual({ goal: null });

  expect(await t.query(api.goalsState.check, { ...scope, threadId: "another" })).toEqual({
    goal: null,
  });

  state.steps.length = state.calls.length;
  state.steps.push(call("goal_check", "new-run", {}));

  await t.withIdentity({ subject: "alice" }).mutation(api.host.send, {
    threadId: receipt.threadId,
    text: "A new request",
    requestKey: "second",
  });

  await drain(t);
  // The goal belongs to the thread: a later run (e.g. after a budget resume) keeps it.
  expect(JSON.stringify(state.calls[state.calls.length - 1]?.prompt)).toContain('"goal":"newer"');
});

it.each(["todo_write", "goal_set"])(
  "%s rejects a conflicting call key and model-supplied ownership",
  async (toolName) => {
    const t = setup();
    const input = toolName === "todo_write" ? { todos: [todo("original")] } : { goal: "original" };
    const changed = toolName === "todo_write" ? { todos: [todo("changed")] } : { goal: "changed" };

    state.steps.push(
      call(toolName, "stable", input),
      call(toolName, "stable", changed),
      call(toolName, "spoof", {
        ...changed,
        subject: "bob",
        threadId: "foreign",
        runId: "foreign",
      }),
    );

    const receipt = await open(t);

    await drain(t);
    const prompt = JSON.stringify(state.calls[state.calls.length - 1]?.prompt);

    expect(prompt).toContain("KEY_CONFLICT");
    const todos = await t.run((ctx) => ctx.db.query("agevexTodos").collect());
    const goals = await t.run((ctx) => ctx.db.query("agevexGoals").collect());

    expect([...todos, ...goals]).toHaveLength(1);
    expect([...todos, ...goals][0]).toMatchObject({ subject: "alice", threadId: receipt.threadId });

    if (toolName === "todo_write") expect(todos[0].todos).toEqual([todo("original")]);
    else expect(goals[0].goal).toBe("original");
  },
);

it("todo admits 100 unique items at exactly 32 KiB with maximum-size core facts, and rejects count, UTF-8 byte, field and duplicate-id overflow", async () => {
  const t = setup();

  const scope = {
    subject: "a".repeat(LIMITS.factBytes),
    threadId: "t".repeat(LIMITS.factBytes),
  };

  const todos = maximumTodos();

  expect(await t.mutation(api.todoState.write, { ...scope, todos })).toEqual({ todos });
  expect(await t.query(api.todoState.read, scope)).toEqual({ todos });

  const invalid = [
    [...todos, todo()],
    todos.map((item, i) => (i === todos.length - 1 ? { ...item, text: item.text + "x" } : item)),
    [todo(), todo()],
    [{ ...todo(), id: "x".repeat(TODO_LIMITS.idChars + 1) }],
    [todo("x".repeat(TODO_LIMITS.textChars + 1))],
    Array.from({ length: TODO_LIMITS.items }, (_, i) => ({
      id: String(i),
      text: "😀".repeat(100),
      done: false,
    })),
  ];

  for (const input of invalid)
    await expect(t.mutation(api.todoState.write, { ...scope, todos: input })).rejects.toThrow();

  expect(await t.query(api.todoState.read, scope)).toEqual({ todos });
  expect(await t.mutation(api.todoState.write, { ...scope, todos: [] })).toEqual({ todos: [] });
});

it("goal state accepts its hard maximum with maximum-size core facts and rejects blank and oversized goals before changing state", async () => {
  const t = setup();

  const scope = {
    subject: "a".repeat(LIMITS.factBytes),
    threadId: "t".repeat(LIMITS.factBytes),
  };

  const goal = "界".repeat(GOAL_LIMITS.goalChars);

  expect(await t.mutation(api.goalsState.set, { ...scope, goal })).toEqual({ goal });
  expect(await t.query(api.goalsState.check, scope)).toEqual({ goal });

  for (const invalid of ["", "   ", goal + "x"])
    await expect(t.mutation(api.goalsState.set, { ...scope, goal: invalid })).rejects.toThrow();

  expect(await t.query(api.goalsState.check, scope)).toEqual({ goal });
});

it("concurrent first writes retain one host row per owner scope", async () => {
  const t = setup();
  const scope = { subject: "alice", threadId: "thread" };

  await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      t.mutation(api.todoState.write, { ...scope, todos: [todo(String(i))] }),
    ),
  );

  await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      t.mutation(api.goalsState.set, { ...scope, goal: String(i) }),
    ),
  );

  expect(await t.run((ctx) => ctx.db.query("agevexTodos").collect())).toHaveLength(1);
  expect(await t.run((ctx) => ctx.db.query("agevexGoals").collect())).toHaveLength(1);
});

it("maximum todo and goal payloads round-trip through managed tools and core receipts with transaction limits enforced", async () => {
  const t = setup();
  const todos = maximumTodos();
  const goal = "界".repeat(GOAL_LIMITS.goalChars);

  state.steps.push(
    call("todo_write", "max-todos", { todos }),
    call("goal_set", "max-goal", { goal }),
    call("todo_read", "max-read", {}),
    call("goal_check", "max-check", {}),
  );

  const receipt = await open(t);

  await drain(t);

  expect(
    await t.withIdentity({ subject: "alice" }).query(api.host.activity, {
      threadId: receipt.threadId,
    }),
  ).toMatchObject({ turnStatus: "idle", errorCode: null });

  expect(state.calls).toHaveLength(5);
  const rows = await t.run((ctx) => ctx.db.query("agevexGoals").collect());

  expect(rows[0].goal).toBe(goal);

  expect(
    await t.query(api.todoState.read, { subject: "alice", threadId: receipt.threadId }),
  ).toEqual({ todos });

  const lastPrompt = JSON.stringify(state.calls[state.calls.length - 1].prompt);

  expect(lastPrompt).toContain(goal);

  const readResult = state.calls[state.calls.length - 1].prompt
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .find((part) => part.type === "tool-result" && part.toolCallId === "max-read");

  expect(readResult).toMatchObject({ output: { type: "json", value: { todos } } });
});

it("goal_set keeps one row per owner and thread: a later run replaces the goal and the table does not grow", async () => {
  const t = setup();

  state.steps.push(call("goal_set", "first-run", { goal: "first" }));
  const receipt = await open(t);

  await drain(t);
  state.steps.length = state.calls.length;

  state.steps.push(
    call("goal_check", "other-run-check", {}),
    call("goal_set", "next-run", { goal: "next" }),
  );

  await t.withIdentity({ subject: "alice" }).mutation(api.host.send, {
    threadId: receipt.threadId,
    text: "Another run",
    requestKey: "second",
  });

  await drain(t);
  // The new run first saw the thread's goal, then replaced it in the same row.
  expect(JSON.stringify(state.calls[state.calls.length - 2].prompt)).toContain('"goal":"first"');
  const rows = await t.run((ctx) => ctx.db.query("agevexGoals").collect());

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ goal: "next" });
});

it.each(["todoState", "goalsState"] as const)(
  "%s cleanup deletes one bounded batch for the target owner or thread only and reports when more remain",
  async (module) => {
    const t = setup();
    const batch = module === "todoState" ? TODO_LIMITS.cleanupBatch : GOAL_LIMITS.cleanupBatch;
    const table = module === "todoState" ? "agevexTodos" : "agevexGoals";

    await t.run(async (ctx) => {
      for (let i = 0; i < batch + 1; i++)
        await ctx.db.insert(
          table,
          module === "todoState"
            ? { subject: "alice", threadId: `t${i}`, todos: [] }
            : { subject: "alice", threadId: `t${i}`, goal: "g" },
        );

      await ctx.db.insert(
        table,
        module === "todoState"
          ? { subject: "bob", threadId: "t0", todos: [] }
          : { subject: "bob", threadId: "t0", goal: "g" },
      );
    });

    const count = () => t.run((ctx) => ctx.db.query(table).collect()).then((rows) => rows.length);

    expect(await t.mutation(api[module].cleanup, { subject: "alice", threadId: "t0" })).toEqual({
      deleted: 1,
      done: true,
    });

    expect(await t.mutation(api[module].cleanup, { subject: "alice" })).toEqual({
      deleted: batch,
      done: true,
    });

    // 129 alice rows - 1 targeted = 128 deleted in one batch; bob is untouched.
    expect(await count()).toBe(1);

    await t.run(async (ctx) => {
      for (let i = 0; i < batch + 1; i++)
        await ctx.db.insert(
          table,
          module === "todoState"
            ? { subject: "alice", threadId: `again${i}`, todos: [] }
            : { subject: "alice", threadId: `again${i}`, goal: "g" },
        );
    });

    expect(await t.mutation(api[module].cleanup, { subject: "alice" })).toEqual({
      deleted: batch,
      done: false,
    });

    expect(await t.mutation(api[module].cleanup, { subject: "alice" })).toEqual({
      deleted: 1,
      done: true,
    });

    expect(await count()).toBe(1);
  },
);
