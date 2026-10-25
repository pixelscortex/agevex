// @vitest-environment edge-runtime
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { fixture, reset, exports, api, critic, text, call } from "./hooks.host.js";
import { requireReceipt } from "./receipt.js";
import { createFunctionHandle } from "convex/server";
import { HOST_LIMITS, LIMITS, type Limits } from "../src/component/limits.js";
import { components } from "./fixture/api.js";
const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);
function setup(limits?: Partial<Limits>) {
  const t = convexTest({
    schema,
    transactionLimits: { bytesRead: 8 << 20, documentsRead: 8192, documentsWritten: 8000 },
    modules: { ...modules, "./fixture/agents.ts": async () => exports(limits) },
  });
  agent.register(t);
  agevex.register(t);
  return t;
}
type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });
const open = (t: Test) =>
  owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "first request", requestKey: "first" })
    .then(requireReceipt);
const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
const calls = (name = "Main") => fixture.calls.filter((call) => call.agent === name);
const send = (t: Test, threadId: string, prompt: string) =>
  owner(t).mutation(api.agents.send, { threadId, text: prompt, requestKey: prompt });
const messages = (t: Test, threadId: string) =>
  owner(t).query(api.agents.messages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });
const status = (t: Test, threadId: string) => owner(t).query(api.agents.activity, { threadId });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const waitFor = async (t: Test, check: () => boolean) =>
  expect
    .poll(async () => {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      return check();
    })
    .toBe(true);
beforeEach(() => {
  reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("beforeTurn can block a turn without calling the model or exposing a hook error", async () => {
  fixture.hooks.beforeTurn = () => ({ block: "intent refused" });
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect(calls()).toHaveLength(0);
  expect((await status(t, receipt.threadId)).turnStatus).toBe("idle");
});

it("beforeTurn notes become escaped user-role context in the same turn", async () => {
  fixture.hooks.beforeTurn = async (hc) => {
    expect(hc.subject).toBe("alice");
    expect(hc.signal.aborted).toBe(false);
    const charge = await hc.meter.estimate("test", { quantity: 1 });
    await charge.settle({ usd: 0 });
    return { note: '<advice from="x">' };
  };
  const t = setup();
  await open(t);
  await drain(t);
  expect(JSON.stringify(calls()[0].args.prompt)).toContain("&lt;advice");
  expect(
    calls()[0].args.prompt.some(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("<note from="),
    ),
  ).toBe(true);
});

it.each(["echo", "native", "once"])(
  "beforeTool rewrites %s arguments and afterTool replaces the visible result",
  async (name) => {
    fixture.steps.Main = (n) => (n === 0 ? call(name, { text: "original" }) : text("finished"));
    fixture.hooks.beforeTool = () => ({ input: { text: "rewritten" } });
    fixture.hooks.afterTool = (_hc, event) => ({ output: `redacted:${event.output}` });
    const t = setup();
    await open(t);
    await drain(t);
    expect(fixture.effects).toEqual(["rewritten"]);
    expect(JSON.stringify(calls()[1].args.prompt)).toContain("redacted:rewritten");
  },
);

it("beforeTool denies an effect and beforeDelegate rewrites or refuses delegation without generic tool hooks", async () => {
  fixture.steps.Main = (n) =>
    n === 0
      ? call("echo", { text: "forbidden" })
      : n === 1
        ? call("agevex_delegate", { agent: "Missing", task: "original" })
        : text("finished");
  fixture.hooks.beforeTool = () => ({ block: "refuse effect" });
  fixture.hooks.beforeDelegate = () => ({ input: { agent: "Builder", task: "rewritten task" } });
  const t = setup();
  await open(t);
  await drain(t);
  expect(fixture.effects).toEqual([]);
  expect(JSON.stringify(calls("Builder")[0].args.prompt)).toContain("rewritten task");
});

it("a throwing tool hook fails the turn with HOOK_FAILED and stores private details outside the transcript", async () => {
  fixture.steps.Main = () => call("echo", { text: "effect" });
  fixture.hooks.beforeTool = () => {
    throw new Error("private hook failure");
  };
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBe("HOOK_FAILED");
  expect(fixture.effects).toEqual([]);
  expect(JSON.stringify(await messages(t, receipt.threadId))).not.toContain("private hook failure");
  const row = await t.query(components.agevex.queue.execution, {
    assignmentId: receipt.assignmentId,
  });
  expect(row?.hookError).toContain("private hook failure");
});

it("model routing applies only at run start and persists across hook continuations", async () => {
  const starts: boolean[] = [];
  fixture.hooks.beforeTurn = (_hc, event) => {
    starts.push(event.isRunStart);
    return event.isRunStart ? { model: "routed" } : undefined;
  };
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn === 1 ? { continue: "check again" } : undefined;
  const t = setup();
  await open(t);
  await drain(t);
  expect(starts).toEqual([true, false]);
  expect(calls("Routed")).toHaveLength(2);
  expect(calls()).toHaveLength(0);
});

it("model returned after run start or outside beforeTurn fails with HOOK_FAILED", async () => {
  fixture.hooks.beforeTurn = (_hc, event) => (event.isRunStart ? undefined : { model: "routed" });
  fixture.hooks.afterTurn = () => ({ continue: "again" });
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBe("HOOK_FAILED");
  expect(calls()).toHaveLength(1);
});

it("afterTurn continuations stop at the per-run cap even when the hook keeps requesting work", async () => {
  fixture.hooks.afterTurn = () => ({ continue: "review again" });
  const t = setup({ continuesPerRun: HOST_LIMITS.continuesPerRun.max });
  await open(t);
  await drain(t);
  expect(calls()).toHaveLength(1 + HOST_LIMITS.continuesPerRun.max);
});

it("an idle note never starts a turn and is included when the next user request arrives", async () => {
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect(
    await owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "wait for next turn",
      from: "critic",
    }),
  ).toBe(true);
  await drain(t);
  expect(calls()).toHaveLength(1);
  expect((await status(t, receipt.threadId)).turnStatus).toBe("idle");
  await send(t, receipt.threadId, "second request");
  await drain(t);
  expect(JSON.stringify(calls()[1].args.prompt)).toContain("wait for next turn");
  expect(
    (await messages(t, receipt.threadId)).page.some(
      (message) => message.role === "user" && message.text.includes('<note from="critic">'),
    ),
  ).toBe(true);
});

it("a note arriving in a running slice becomes context in the next slice", async () => {
  const held = gate();
  fixture.steps.Main = async (n) => {
    if (n === 0) {
      await held.promise;
      return call("echo", { text: "effect" });
    }
    return text("done");
  };
  const t = setup();
  const receipt = await open(t);
  await waitFor(t, () => calls().length === 1);
  await owner(t).mutation(api.agents.note, {
    threadId: receipt.threadId,
    text: "between slices",
    from: "critic",
  });
  held.release();
  await drain(t);
  expect(JSON.stringify(calls()[1].args.prompt)).toContain("between slices");
});

it("notes enforce their hard count and length bounds and authorize the watched thread", async () => {
  const t = setup({
    notesPerTurn: HOST_LIMITS.notesPerTurn.max,
    queueLength: HOST_LIMITS.queueLength.max,
  });
  const receipt = await open(t);
  await drain(t);
  for (let i = 0; i < HOST_LIMITS.notesPerTurn.max; i++)
    expect(
      await owner(t).mutation(api.agents.note, {
        threadId: receipt.threadId,
        text: "&".repeat(4000),
        from: "critic",
      }),
    ).toBe(true);
  expect(
    await owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "overflow",
      from: "critic",
    }),
  ).toBe(false);
  await expect(
    t.withIdentity({ subject: "mallory" }).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "unauthorized",
      from: "critic",
    }),
  ).rejects.toThrow("FORBIDDEN");
  await send(t, receipt.threadId, "consume maximum notes");
  await drain(t);
  expect(calls()).toHaveLength(2);
});

it("side reviews follow turn cadence, preserve skipped deltas and deliver passive notes readable in both threads", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 2 }, sees: "delta" }];
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect(calls("Critic")).toHaveLength(0);
  await send(t, receipt.threadId, "second boundary");
  await drain(t);
  expect(calls("Critic")).toHaveLength(1);
  const first = JSON.stringify(calls("Critic")[0].args.prompt);
  expect(first).toContain("first request");
  expect(first).toContain("second boundary");
  await send(t, receipt.threadId, "third boundary");
  await drain(t);
  await send(t, receipt.threadId, "fourth boundary");
  await drain(t);
  const second = JSON.stringify(calls("Critic")[1].args.prompt);
  expect(second).toContain("third boundary");
  expect(second).not.toContain("first request");
  expect(calls()).toHaveLength(4);
  const tree = await owner(t).query(api.agents.runTree, { threadId: receipt.threadId });
  const child = tree.find((run) => run.agent === "Critic")!;
  expect(
    (await messages(t, child.childThreadId!)).page.some((message) => message.role === "assistant"),
  ).toBe(true);
  expect(
    (await messages(t, receipt.threadId)).page.some((message) =>
      message.text.includes('<note from="Critic">'),
    ),
  ).toBe(true);
});

it("minute cadence compares to the last review without scheduled review chains", async () => {
  fixture.sides = [{ agent: critic, every: { minutes: 1 }, sees: "delta" }];
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect(calls("Critic")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(60_000);
  await send(t, receipt.threadId, "after minute");
  await drain(t);
  expect(calls("Critic")).toHaveLength(1);
  await send(t, receipt.threadId, "too soon");
  await drain(t);
  expect(calls("Critic")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  await send(t, receipt.threadId, "another minute");
  await drain(t);
  expect(calls("Critic")).toHaveLength(2);
});

it("side cap is separate from model delegation and NONE posts no note", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn <= 3 ? { continue: "more work" } : undefined;
  fixture.steps.Critic = () => text("NONE");
  const t = setup({ sideRunsPerRun: 2 });
  const receipt = await open(t);
  await drain(t);
  expect(calls("Critic")).toHaveLength(2);
  expect(calls()).toHaveLength(4);
  expect(
    (await messages(t, receipt.threadId)).page.some((message) =>
      message.text.includes('<note from="Critic">'),
    ),
  ).toBe(false);
});

it("a delegated parent settles while its side run is held, and a side failure never fails that parent", async () => {
  const held = gate();
  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "work" }) : text("parent finished");
  fixture.steps.Critic = async () => {
    await held.promise;
    throw new Error("critic failed privately");
  };
  const t = setup();
  const receipt = await open(t);
  await waitFor(t, () => calls("Critic").length === 1 && calls().length === 2);
  expect((await status(t, receipt.threadId)).turnStatus).toBe("idle");
  held.release();
  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
  expect(calls()).toHaveLength(2);
});

it.each(
  (["turn end", "failed each delivery", "empty all release"] as const).flatMap((path) =>
    (["before", "after"] as const).map((sideSettlement) => ({ path, sideSettlement })),
  ),
)(
  "passive notes and side reviews never fence R3 at $path, with side settlement $sideSettlement the parent",
  async ({ path, sideSettlement }) => {
    const t = setup(
      Object.fromEntries(Object.entries(HOST_LIMITS).map(([name, { max }]) => [name, max])),
    );
    const receipt = await open(t);
    const root = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:0` };
    await t.mutation(components.agevex.queue.claim, root);
    const launch = async (
      parent: typeof root,
      agent: string,
      extra: { side?: boolean; group?: string; wait?: "all" } = {},
    ) => {
      const response = await t.mutation(api.agents.coordinate!, {
        op: "launch",
        assignmentId: parent.assignmentId,
        turnToken: parent.turnToken,
        toolCallId: crypto.randomUUID(),
        agent,
        task: "review the work",
        ...extra,
      });
      if (response?.status !== "queued") throw new Error(JSON.stringify(response));
      const tree = await owner(t).query(api.agents.runTree, { threadId: receipt.threadId });
      const child = tree.find((run) => run.runId === response.runId)!;
      const turn = {
        assignmentId: child.childAssignmentId!,
        turnToken: `${child.childAssignmentId}:0`,
      };
      const claimed = await t.mutation(components.agevex.queue.claim, turn);
      return { ...turn, threadId: child.childThreadId!, ...claimed!.subagent! };
    };
    const builder = await launch(root, "Builder");
    const ordinary =
      path === "turn end"
        ? null
        : await launch(
            builder,
            "Critic",
            path === "empty all release" ? { group: "empty", wait: "all" } : {},
          );
    const saved = await t.run(async (ctx) =>
      ctx.runMutation(components.agevex.queue.write, {
        assignmentId: builder.assignmentId,
        executionId: builder.turnToken,
        cancellationEpoch: 0,
        handle: await createFunctionHandle(components.agent.messages.addMessages),
        nativeMessages: {
          getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
          finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
        },
        args: {
          threadId: builder.threadId,
          agentName: "Builder",
          messages: [{ message: { role: "assistant", content: "verified Builder outcome" } }],
        },
      }),
    );
    await t.mutation(components.agevex.hooks.hookState, {
      assignmentId: builder.assignmentId,
      executionId: builder.turnToken,
      complete: true,
    });
    const side = await launch(builder, "Critic", { side: true });
    // Fill the passive-note allowance at the hard maximum. These real native
    // saves leave inbox rows present throughout both settlement paths, under
    // the enforced 8 MiB transaction gate; R3 must inspect only ready work.
    for (let n = 0; n < HOST_LIMITS.notesPerTurn.max; n++)
      expect(
        await owner(t).mutation(api.agents.note, {
          threadId: builder.threadId,
          text: `passive review ${n}`,
          from: "critic",
        }),
      ).toBe(true);
    const builderStatus = async () =>
      (await owner(t).query(api.agents.runTree, { threadId: receipt.threadId })).find(
        (run) => run.runId === builder.runId,
      )!.status;
    const fail = async (child: typeof side) => {
      await t.mutation(components.agevex.subagents.settle, {
        assignmentId: child.assignmentId,
        turnToken: child.turnToken,
        runId: child.runId,
        childResultMessageId: null,
        errorCode: "GENERATION_FAILED",
      });
      await t.mutation(components.agevex.subagents.deliver, {
        runId: child.runId,
        deliveryToken: child.deliveryToken,
        deliveryStatus: "failed",
        parentMessageId: null,
        errorCode: "DELIVERY_FAILED",
      });
      await t.mutation(components.agevex.queue.finish, {
        assignmentId: child.assignmentId,
        turnToken: child.turnToken,
        errorCode: null,
      });
    };
    if (sideSettlement === "before" && !ordinary) {
      await fail(side);
      expect(await builderStatus()).toBe("running");
    }
    expect(
      await t.mutation(api.agents.coordinate!, {
        op: "settle",
        assignmentId: builder.assignmentId,
        turnToken: builder.turnToken,
        runId: builder.runId,
        resultMessageId: (saved as { messages: { _id: string }[] }).messages[0]._id,
        errorCode: null,
      }),
    ).toEqual(ordinary ? { status: "deferred", runId: builder.runId } : null);
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: builder.assignmentId,
      turnToken: builder.turnToken,
      errorCode: null,
    });
    if (ordinary) {
      expect(await builderStatus()).toBe("running");
      if (sideSettlement === "before") {
        await fail(side);
        expect(await builderStatus()).toBe("running");
      }
      await fail(ordinary);
    }
    expect(await builderStatus()).toBe("completed");
    if (sideSettlement === "after") {
      await fail(side);
      expect(await builderStatus()).toBe("completed");
    }
    await t.mutation(api.agents.coordinate!, {
      op: "notify",
      runId: builder.runId,
      deliveryToken: builder.deliveryToken,
    });
    await t.mutation(components.agevex.queue.finish, { ...root, errorCode: null });
    await drain(t);
    expect(calls("Builder")).toHaveLength(0);
    expect(calls("Critic")).toHaveLength(0);
    expect(calls()).toHaveLength(1);
    expect(JSON.stringify(calls()[0].args.prompt)).toContain("verified Builder outcome");
  },
);

it("cancel stops side runs and fences their late notes", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  const held = gate();
  fixture.steps.Critic = async () => {
    await held.promise;
    return text("late review");
  };
  const t = setup();
  const receipt = await open(t);
  await waitFor(t, () => calls("Critic").length === 1);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
  expect((await status(t, receipt.threadId)).subagents.active).toBe(0);
  expect(JSON.stringify(await messages(t, receipt.threadId))).not.toContain("late review");
});

it("beforeDelegate can refuse a child without calling generic tool hooks or spending a launch", async () => {
  fixture.steps.Main = (n) =>
    n === 0
      ? call("agevex_delegate", { agent: "Builder", task: "refused" })
      : text("denial handled");
  fixture.hooks.beforeDelegate = () => ({ block: "declined by host" });
  fixture.hooks.beforeTool = () => {
    throw new Error("reserved tool reached generic hook");
  };
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect(calls("Builder")).toHaveLength(0);
  expect(JSON.stringify(calls()[1].args.prompt)).toContain("HOOK_BLOCKED");
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
});

it("a model result from afterTurn is rejected even on the first turn", async () => {
  fixture.hooks.afterTurn = () => ({ model: "routed" });
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBe("HOOK_FAILED");
});

it("all side and continuation hard maxima leave the model delegation budget available", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  fixture.steps.Critic = () => text("NONE");
  fixture.steps.Main = (n) =>
    n === HOST_LIMITS.continuesPerRun.max
      ? call("agevex_delegate", { agent: "Builder", task: "one model launch" })
      : text("root work");
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn <= HOST_LIMITS.continuesPerRun.max
      ? { continue: "continue bounded work" }
      : undefined;
  const t = setup({
    continuesPerRun: HOST_LIMITS.continuesPerRun.max,
    sideRunsPerRun: HOST_LIMITS.sideRunsPerRun.max,
    activeChildrenPerRoot: HOST_LIMITS.activeChildrenPerRoot.max,
    runLaunches: 1,
  });
  const receipt = await open(t);
  await drain(t);
  expect(calls("Critic")).toHaveLength(HOST_LIMITS.sideRunsPerRun.max);
  expect(calls("Builder")).toHaveLength(1);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
});

it("an empty side reply produces no note and never fails its watched turn", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  fixture.steps.Critic = () => text("");
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
  expect(
    (await messages(t, receipt.threadId)).page.some((message) =>
      message.text.includes('<note from="Critic">'),
    ),
  ).toBe(false);
});

it("a maximum-size delta reads bounded exact source ids and sends at most 48 KiB of recent text", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  const t = setup(
    Object.fromEntries(Object.entries(HOST_LIMITS).map(([name, { max }]) => [name, max])),
  );
  const receipt = await open(t);
  const fence = {
    assignmentId: receipt.assignmentId,
    executionId: `${receipt.assignmentId}:0`,
    cancellationEpoch: 0,
  };
  expect(
    await t.mutation(components.agevex.queue.claim, {
      assignmentId: receipt.assignmentId,
      turnToken: fence.executionId,
    }),
  ).not.toBeNull();
  // Each native source is ~900 KiB (body plus text projection). The full ring
  // exceeds 16 MiB; a transcript/body scan would fail the enforced 8 MiB gate.
  for (let index = 0; index < LIMITS.contextMessages; index++) {
    await t.run(async (ctx) =>
      ctx.runMutation(components.agevex.queue.write, {
        ...fence,
        handle: await createFunctionHandle(components.agent.messages.addMessages),
        nativeMessages: {
          getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
          finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
        },
        args: {
          threadId: receipt.threadId,
          messages: [
            { message: { role: "assistant", content: `source-${index}:` + "界".repeat(150_000) } },
          ],
        },
      }),
    );
  }
  await t.mutation(components.agevex.hooks.hookState, {
    assignmentId: receipt.assignmentId,
    executionId: fence.executionId,
    complete: true,
  });
  expect(
    await t.mutation(api.agents.coordinate!, {
      op: "launch",
      side: true,
      assignmentId: receipt.assignmentId,
      turnToken: fence.executionId,
      toolCallId: "max-delta",
      agent: "Critic",
      task: "review exact delta",
    }),
  ).toMatchObject({ status: "queued" });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: receipt.assignmentId,
    turnToken: fence.executionId,
    errorCode: null,
  });
  await drain(t);
  const prompt = calls("Critic")[0]
    .args.prompt.map((message) => JSON.stringify(message.content))
    .join("\n");
  expect(new TextEncoder().encode(prompt).byteLength).toBeLessThan(
    LIMITS.contextBytes + LIMITS.taskLength,
  );
  expect(prompt).toContain(`source-${LIMITS.contextMessages - 1}:`);
  expect(prompt).not.toContain("source-0:");
});

it("concurrent sibling turns share the first run-start model decision without duplicate classifiers", async () => {
  const held = gate();
  const starts: boolean[] = [];
  fixture.steps.Main = (n) =>
    n === 0
      ? [
          ...call("agevex_delegate", { agent: "Builder", task: "one" }),
          ...call("agevex_delegate", { agent: "Builder", task: "two" }),
        ]
      : text("done");
  fixture.builderHooks.beforeTurn = async (_hc, event) => {
    starts.push(event.isRunStart);
    if (event.isRunStart) {
      await held.promise;
      return { model: "routed" };
    }
  };
  const t = setup();
  await open(t);
  await waitFor(t, () => starts.length === 2);
  expect(starts).toEqual([true, false]);
  expect(calls("Builder")).toHaveLength(0);
  expect(calls("Routed")).toHaveLength(0);
  held.release();
  await drain(t);
  expect(calls("Routed")).toHaveLength(2);
  expect(calls("Builder")).toHaveLength(0);
});

it("queued future prompts never hide an earlier assistant response from the next review delta", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  const held = gate();
  fixture.steps.Main = async (n) => {
    if (n === 0) await held.promise;
    return text(`actual reply ${n}`);
  };
  fixture.steps.Critic = () => text("NONE");
  const t = setup();
  const receipt = await open(t);
  await waitFor(t, () => calls().length === 1);
  await send(t, receipt.threadId, "queued second request");
  await send(t, receipt.threadId, "queued third request");
  held.release();
  await drain(t);
  expect(calls("Critic")).toHaveLength(3);
  const second = JSON.stringify(calls("Critic")[1].args.prompt);
  expect(second).toContain("actual reply 1");
  expect(second).not.toContain("actual reply 0");
});
