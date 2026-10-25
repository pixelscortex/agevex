// @vitest-environment edge-runtime
import { requireReceipt } from "./receipt.js";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { createThread, saveMessage } from "@convex-dev/agent";
import { componentsGeneric, type FunctionReference, createFunctionHandle } from "convex/server";
import { workflowCall } from "../src/testing/expect-journal.js";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { HOST_LIMITS, LIMITS } from "../src/component/limits.js";
import { components } from "./fixture/api.js";
import { coordinateReference, runTurnReference } from "./host.js";
import {
  v2,
  v2api as api,
  registration,
  reset,
  text,
  call,
  delegate,
  main,
  builder,
  reviewer,
} from "./delegation-v2.host.js";
import { Agent, registerAgent, type Registration } from "../src/client/index.js";
import { mockModel } from "@convex-dev/agent";

const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);
const maxima = Object.fromEntries(Object.entries(HOST_LIMITS).map(([key, { max }]) => [key, max]));
const enforced = { bytesRead: 8 << 20, documentsRead: 4096, documentsWritten: 8000 };
function setup(limits?: Registration["limits"], preclaimFailure = false) {
  reset();
  const t = convexTest({
    schema,
    transactionLimits: enforced,
    modules: {
      ...modules,
      "./fixture/agents.ts": async () => {
        const host = await import("./delegation-v2.host.js");
        const runtime = host.registration(limits, preclaimFailure);
        return {
          ...runtime.internalFunctions(),
          ...runtime.authorizedEndpoints(),
          failBeforeClaim: host.failBeforeClaim,
        };
      },
    },
  });
  agent.register(t);
  agevex.register(t);
  return t;
}
type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });
const open = (t: Test, requestKey = "v2") =>
  owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "do the work", requestKey })
    .then(requireReceipt);
const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
const calls = (agent: string) => v2.calls.filter((entry) => entry.agent === agent);
const tree = (t: Test, threadId: string) => owner(t).query(api.agents.runTree, { threadId });
const tick = (t: Test) =>
  t.action(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
const waitFor = async (t: Test, check: () => boolean) =>
  expect
    .poll(async () => {
      await tick(t);
      return check();
    })
    .toBe(true);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("Main → Builder → Reviewer returns verified results to each immediate parent at depth two", async () => {
  const t = setup();
  v2.steps.Main = (n) => (n === 0 ? [delegate("Builder")] : text("Main finished"));
  v2.steps.Builder = (n) => (n === 0 ? [delegate("Reviewer")] : text("Builder finished"));
  const receipt = await open(t);
  await drain(t);
  expect(calls("Main")).toHaveLength(2);
  expect(calls("Builder")).toHaveLength(2);
  expect(calls("Reviewer")).toHaveLength(1);
  expect(JSON.stringify(calls("Builder")[1].args.prompt)).toContain("Reviewer result 0");
  expect(JSON.stringify(calls("Main")[1].args.prompt)).toContain("Builder finished");
  expect(await tree(t, receipt.threadId)).toMatchObject([
    { agent: "Builder", depth: 1, status: "completed" },
    { agent: "Reviewer", depth: 2, status: "completed" },
  ]);
});

it("registration rejects depth three, cycles and all reserved tools while sharing one child across parents", () => {
  expect(() => registration()).not.toThrow();
  const extra = new Agent(components.agent, {
    name: "Extra",
    languageModel: mockModel(),
    subagents: [main],
  });
  const policy: Registration = {
    agents: [extra],
    refs: { runTurn: runTurnReference, coordinate: coordinateReference },
    authorize: async () => ({ subject: "alice" }),
    authorizeExecution: async () => {},
  };
  expect(() => registerAgent(components.agevex, policy)).toThrow("SUBAGENT_DEPTH");
  expect(() => registration({ maxDepth: 1 })).toThrow("SUBAGENT_DEPTH");
  for (const toolName of ["agevex_delegate", "agevex_message_child", "agevex_ask_parent"]) {
    const reserved = new Agent(components.agent, {
      name: "Reserved",
      languageModel: mockModel(),
      subagents: [],
      tools: { [toolName]: {} as never },
    });
    expect(() => registerAgent(components.agevex, { ...policy, agents: [reserved] })).toThrow(
      "RESERVED_TOOL_NAME",
    );
    const parent = new Agent(components.agent, {
      name: "Parent",
      languageModel: mockModel(),
      subagents: [reserved],
    });
    expect(() => registerAgent(components.agevex, { ...policy, agents: [parent] })).toThrow(
      "RESERVED_TOOL_NAME",
    );
  }
  const cyclic = new Agent(components.agent, {
    name: "Cyclic",
    languageModel: mockModel(),
    subagents: [],
  });
  Object.defineProperty(cyclic, "subagents", { value: [cyclic] });
  expect(() => registerAgent(components.agevex, { ...policy, agents: [cyclic] })).toThrow(
    "SUBAGENT_CYCLE",
  );
  expect(builder.subagents[0]).toBe(reviewer);
  expect(main.subagents[1]).toBe(reviewer);
});

it.each([false, true])(
  "wait all wakes its parent once with three results, including a failed member: failure=%s",
  async (fail) => {
    const t = setup();
    v2.steps.Main = (n) =>
      n === 0
        ? Array.from({ length: 3 }, () => delegate("Reviewer", { group: "draft", wait: "all" }))
        : text("joined");
    v2.steps.Reviewer = (n) => {
      if (fail && n === 1) throw new Error("private failure");
      return text(`member ${n}`);
    };
    const receipt = await open(t);
    await drain(t);
    expect(calls("Main")).toHaveLength(2);
    const context = JSON.stringify(calls("Main")[1].args.prompt);
    expect(context).toContain("member 0");
    expect(context).toContain("member 2");
    expect(context).toContain(fail ? "failed the delegated task" : "member 1");
    expect(await tree(t, receipt.threadId)).toHaveLength(3);
  },
);

it("cancel mid-group fences unfinished members and prevents a join continuation", async () => {
  const t = setup();
  const held = gate();
  v2.steps.Main = (n) =>
    n === 0
      ? Array.from({ length: 3 }, () => delegate("Reviewer", { group: "draft", wait: "all" }))
      : text("must not run");
  v2.steps.Reviewer = async (n) => {
    if (n > 0) await held.promise;
    return text(`member ${n}`);
  };
  const receipt = await open(t);
  await waitFor(t, () => calls("Reviewer").length === 3);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
  expect(calls("Main")).toHaveLength(1);
  expect(
    (await tree(t, receipt.threadId)).filter(
      (run) => run.status === "running" || run.status === "asking",
    ),
  ).toEqual([]);
});

it("ask_parent pauses once, rejects a second open question, and message_child resumes the child", async () => {
  const t = setup();
  v2.steps.Main = (n, args) => {
    if (n === 0) return [delegate("Reviewer")];
    if (n === 1) {
      const match = JSON.stringify(args.prompt).match(/asks \(run ([^)]+)\)/);
      if (!match) throw new Error("QUESTION_MISSING");
      return [call("agevex_message_child", { runId: match[1], text: "the answer is yes" })];
    }
    return text("parent final");
  };
  v2.steps.Reviewer = (n) =>
    n === 0
      ? [
          call("agevex_ask_parent", { question: "which option?" }),
          call("agevex_ask_parent", { question: "second question" }),
        ]
      : text("child completed");
  const receipt = await open(t);
  await drain(t);
  expect(calls("Reviewer")).toHaveLength(2);
  expect(JSON.stringify(calls("Reviewer")[1].args.prompt)).toContain("the answer is yes");
  const runs = await tree(t, receipt.threadId);
  expect(runs[0].status).toBe("completed");
  const transcript = await owner(t).query(api.agents.messages, {
    threadId: runs[0].childThreadId!,
    paginationOpts: { cursor: null, numItems: 50 },
  });
  expect(JSON.stringify(transcript)).toContain("ASK_PENDING");
});

it("cancel while asking settles the run and a late answer cannot cross the root epoch fence", async () => {
  const t = setup();
  const held = gate();
  v2.steps.Main = async (n) => {
    if (n === 0) return [delegate("Reviewer")];
    await held.promise;
    return text("late");
  };
  v2.steps.Reviewer = () => [call("agevex_ask_parent", { question: "waiting?" })];
  const receipt = await open(t);
  await waitFor(t, () => calls("Main").length === 2);
  expect((await tree(t, receipt.threadId))[0].status).toBe("asking");
  const actor = await t.query(components.agevex.queue.execution, {
    assignmentId: receipt.assignmentId,
  });
  const run = (await tree(t, receipt.threadId))[0];
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: receipt.assignmentId,
      turnToken: actor!.turnToken!,
      runId: run.runId,
      text: "late answer",
    }),
  ).toMatchObject({ status: "denied", code: "STALE_TURN" });
  held.release();
  await drain(t);
  expect((await tree(t, receipt.threadId))[0].status).toBe("failed");
});

it("runTree exposes the full current tree and rejects non-owners and child thread ids", async () => {
  const t = setup();
  v2.steps.Main = (n) => (n === 0 ? [delegate("Builder")] : text("done"));
  v2.steps.Builder = (n) => (n === 0 ? [delegate("Reviewer")] : text("done"));
  const receipt = await open(t);
  await drain(t);
  const rows = await tree(t, receipt.threadId);
  expect(rows.map((run) => run.depth)).toEqual([1, 2]);
  expect(rows[1].parentAssignmentId).toBe(rows[0].childAssignmentId);
  expect(Object.keys(rows[0]).sort()).toEqual([
    "agent",
    "childAssignmentId",
    "childThreadId",
    "createdAt",
    "depth",
    "finishedAt",
    "group",
    "parentAssignmentId",
    "runId",
    // Public run records now expose their side-run discriminator.
    "side",
    "startedAt",
    "status",
  ]);
  await expect(
    t
      .withIdentity({ subject: "mallory" })
      .query(api.agents.runTree, { threadId: receipt.threadId }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(tree(t, rows[0].childThreadId!)).rejects.toThrow("FORBIDDEN");
});

it("managed tool names are offered only on parents and children where they are meaningful", async () => {
  const t = setup();
  v2.steps.Main = (n) => (n === 0 ? [delegate("Builder")] : text("done"));
  v2.steps.Builder = (n) => (n === 0 ? [delegate("Reviewer")] : text("done"));
  await open(t);
  await drain(t);
  const names = (name: string) =>
    calls(name)[0]
      .args.tools?.map((tool) => tool.name)
      .sort();
  expect(names("Main")).toEqual(["agevex_delegate", "agevex_message_child"]);
  expect(names("Builder")).toEqual([
    "agevex_ask_parent",
    "agevex_delegate",
    "agevex_message_child",
  ]);
  expect(names("Reviewer")).toEqual(["agevex_ask_parent"]);
});

async function manualRoot(t: Test, requestKey = "manual") {
  const receipt = await open(t, requestKey);
  const turn = {
    assignmentId: receipt.assignmentId,
    turnToken: receipt.assignmentId + ":0",
    threadId: receipt.threadId,
  };
  expect(
    await t.mutation(components.agevex.queue.claim, {
      assignmentId: turn.assignmentId,
      turnToken: turn.turnToken,
    }),
  ).not.toBeNull();
  return turn;
}
async function launch(
  t: Test,
  parent: { assignmentId: string; turnToken: string },
  agent: string,
  extra: object = {},
) {
  const response = await t.mutation(api.agents.coordinate, {
    op: "launch",
    assignmentId: parent.assignmentId,
    turnToken: parent.turnToken,
    toolCallId: crypto.randomUUID(),
    agent,
    task: "😀".repeat(HOST_LIMITS.taskLength.max / 2),
    ...extra,
  });
  if (response?.status !== "queued") throw new Error(JSON.stringify(response));
  const actor = (await t.query(components.agevex.queue.execution, {
    assignmentId: parent.assignmentId,
  }))!;
  const root = actor.rootAssignmentId
    ? (await t.query(components.agevex.queue.execution, { assignmentId: actor.rootAssignmentId }))!
    : actor;
  const runs = await t.query(components.agevex.subagents.delegations, {
    threadId: root.threadId,
    subject: "alice",
    paginationOpts: { cursor: null, numItems: 50 },
  });
  const run = runs.page.find((entry) => entry.runId === response.runId)!;
  const assignment = await t.query(components.agevex.queue.assignment, {
    threadId: run.childThreadId!,
  });
  const turn = {
    assignmentId: assignment!.assignmentId,
    turnToken: assignment!.assignmentId + ":0",
    threadId: run.childThreadId!,
  };
  const claimed = await t.mutation(components.agevex.queue.claim, {
    assignmentId: turn.assignmentId,
    turnToken: turn.turnToken,
  });
  expect(claimed?.subagent).not.toBeNull();
  return { ...turn, runId: run.runId, deliveryToken: claimed!.subagent!.deliveryToken };
}
async function nativeSave(
  t: Test,
  turn: { assignmentId: string; turnToken: string; threadId: string },
  agentName: string,
  content: string,
  status: "success" | "pending" = "success",
) {
  return t.run(async (ctx) => {
    const saved = (await ctx.runMutation(components.agevex.queue.write, {
      assignmentId: turn.assignmentId,
      executionId: turn.turnToken,
      cancellationEpoch: 0,
      handle: await createFunctionHandle(components.agent.messages.addMessages),
      nativeMessages: {
        getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
        finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
      },
      args: {
        threadId: turn.threadId,
        agentName,
        failPendingSteps: false,
        messages: [{ message: { role: "assistant", content }, status }],
      },
    })) as { messages: { _id: string }[] };
    return saved.messages[0]._id;
  });
}

async function complete(t: Test, child: Awaited<ReturnType<typeof launch>>, result: string) {
  const resultMessageId = await nativeSave(t, child, "Reviewer", result);
  await t.mutation(api.agents.coordinate, {
    op: "settle",
    assignmentId: child.assignmentId,
    turnToken: child.turnToken,
    runId: child.runId,
    resultMessageId,
    errorCode: null,
  });
  await t.mutation(api.agents.coordinate, {
    op: "notify",
    runId: child.runId,
    deliveryToken: child.deliveryToken,
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: child.assignmentId,
    turnToken: child.turnToken,
    errorCode: null,
  });
}

// R2 removes held results: a child must finish its descendants before asking.
it("ask_parent denies ASK_WITH_CHILDREN until Reviewer settles, then answers resume Builder", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const builder = await launch(t, root, "Builder");
  const reviewer = await launch(t, builder, "Reviewer");
  const ask = () =>
    t.mutation(api.agents.coordinate, {
      op: "ask",
      assignmentId: builder.assignmentId,
      turnToken: builder.turnToken,
      question: "which revision?",
    });
  expect(await ask()).toMatchObject({ status: "denied", code: "ASK_WITH_CHILDREN" });
  expect((await tree(t, root.threadId))[0].status).toBe("running");
  await complete(t, reviewer, "review before the question");
  expect(await ask()).toMatchObject({ status: "accepted" });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: builder.assignmentId,
    turnToken: builder.turnToken,
    errorCode: null,
  });
  expect(
    await t.query(components.agevex.queue.execution, { assignmentId: builder.assignmentId }),
  ).toMatchObject({ turnStatus: "idle", queuedMessages: 1 });
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      runId: builder.runId,
      text: "use revision two",
    }),
  ).toMatchObject({ status: "accepted" });
  v2.steps.Builder = () => text("Builder completed with the answer and review");
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  await drain(t);
  expect(calls("Builder")).toHaveLength(1);
  const context = JSON.stringify(calls("Builder")[0].args.prompt);
  expect(context).toContain("use revision two");
  expect(context).toContain("review before the question");
  expect((await tree(t, root.threadId)).every((run) => run.status === "completed")).toBe(true);
});

it.each(["finish", "slice"] as const)(
  "a member settling between same-turn launches joins both members only after the launching %s seals membership",
  async (boundary) => {
    const t = setup(maxima);
    const root = await manualRoot(t);
    const first = await launch(t, root, "Reviewer", { group: "draft", wait: "all" });
    await complete(t, first, "first member");
    const second = await launch(t, root, "Reviewer", { group: "draft", wait: "all" });
    expect(
      (
        await t.query(components.agevex.queue.execution, {
          assignmentId: root.assignmentId,
        })
      )?.queuedMessages,
    ).toBe(0);
    if (boundary === "slice") {
      const messageId = await nativeSave(t, root, "Main", "launching slice ended");
      await t.mutation(components.agevex.queue.continueTurn, {
        assignmentId: root.assignmentId,
        executionId: root.turnToken,
        cancellationEpoch: 0,
        messageId,
      });
      await t.mutation(components.agevex.queue.claim, {
        assignmentId: root.assignmentId,
        turnToken: root.turnToken,
        sliceId: "next-slice",
      });
      expect(
        await t.mutation(api.agents.coordinate, {
          op: "launch",
          assignmentId: root.assignmentId,
          turnToken: root.turnToken,
          toolCallId: "after-slice",
          agent: "Reviewer",
          task: "too late",
          group: "draft",
          wait: "all",
        }),
      ).toMatchObject({ status: "denied", code: "GROUP_CLOSED" });
      await complete(t, second, "second member");
    }
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      errorCode: null,
    });
    if (boundary === "finish") await complete(t, second, "second member");
    const current = (await t.query(components.agevex.queue.execution, {
      assignmentId: root.assignmentId,
    }))!;
    expect(current.turnStatus).toBe("queued");
    const claimed = await t.mutation(components.agevex.queue.claim, {
      assignmentId: root.assignmentId,
      turnToken: current.turnToken!,
    });
    expect(
      await t.mutation(api.agents.coordinate, {
        op: "launch",
        assignmentId: root.assignmentId,
        turnToken: current.turnToken!,
        toolCallId: "after-seal",
        agent: "Reviewer",
        task: "too late",
        group: "draft",
        wait: "all",
      }),
    ).toMatchObject({ status: "denied", code: "GROUP_CLOSED" });
    const messages = await owner(t).query(api.agents.messages, {
      threadId: root.threadId,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    expect(JSON.stringify(messages)).toContain("first member");
    expect(
      (
        await t.query(components.agent.messages.getMessagesByIds, {
          messageIds: [claimed!.promptMessageId],
        })
      )[0]?.text,
    ).toContain("second member");
    expect(
      (
        await t.query(components.agevex.queue.execution, {
          assignmentId: root.assignmentId,
        })
      )?.queuedMessages,
    ).toBe(0);
    await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
    await drain(t);
  },
);

it.each(["join", "question"] as const)(
  "an older each result stays ahead of a newer %s and consecutive ready work is consumed once",
  async (kind) => {
    const t = setup(maxima);
    const root = await manualRoot(t);
    const first = await launch(t, root, "Reviewer");
    const slow = await launch(t, root, "Reviewer");
    const independent = await launch(t, root, "Reviewer", { group: "independent", wait: "all" });
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      errorCode: null,
    });
    // R1 removes sibling waits and bypass: the first settled each is ready now.
    await complete(t, first, "older each result");
    expect(
      (
        await t.query(components.agevex.queue.execution, {
          assignmentId: root.assignmentId,
        })
      )?.turnStatus,
    ).toBe("queued");
    if (kind === "join") await complete(t, independent, "independent join result");
    else
      expect(
        await t.mutation(api.agents.coordinate, {
          op: "ask",
          assignmentId: independent.assignmentId,
          turnToken: independent.turnToken,
          question: "independent question",
        }),
      ).toMatchObject({ status: "accepted" });
    let current = (await t.query(components.agevex.queue.execution, {
      assignmentId: root.assignmentId,
    }))!;
    expect(current.turnStatus).toBe("queued");
    const claimed = await t.mutation(components.agevex.queue.claim, {
      assignmentId: root.assignmentId,
      turnToken: current.turnToken!,
    });
    expect(
      (
        await t.query(components.agent.messages.getMessagesByIds, {
          messageIds: [claimed!.promptMessageId],
        })
      )[0]?.text,
    ).toContain(kind === "join" ? "independent join result" : "independent question");
    expect(
      (
        await t.query(components.agevex.queue.execution, {
          assignmentId: root.assignmentId,
        })
      )?.queuedMessages,
    ).toBe(0);
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: root.assignmentId,
      turnToken: current.turnToken!,
      errorCode: null,
    });
    await complete(t, slow, "last each result");
    current = (await t.query(components.agevex.queue.execution, {
      assignmentId: root.assignmentId,
    }))!;
    await t.mutation(components.agevex.queue.claim, {
      assignmentId: root.assignmentId,
      turnToken: current.turnToken!,
    });
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: root.assignmentId,
      turnToken: current.turnToken!,
      errorCode: null,
    });
    expect(
      await t.query(components.agevex.queue.execution, {
        assignmentId: root.assignmentId,
      }),
    ).toMatchObject({ turnStatus: "idle", queuedMessages: 0 });
    await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
    await drain(t);
  },
);

it("cancel at all maxima fences live loop → turn → Workpool dispatch chains within transaction limits", async () => {
  const held = gate();
  const t = setup(maxima);
  for (const name of ["Main", "Builder", "Reviewer"])
    v2.steps[name] = async () => {
      await held.promise;
      return text("late output must be fenced");
    };
  const root = await manualRoot(t);
  const parent = await launch(t, root, "Builder");
  const descendants = [parent];
  for (let i = 1; i < HOST_LIMITS.activeChildrenPerRoot.max; i++)
    descendants.push(await launch(t, parent, "Reviewer"));
  for (const child of descendants) {
    expect(
      await t.mutation(api.agents.coordinate, {
        op: "message",
        assignmentId: root.assignmentId,
        turnToken: root.turnToken,
        runId: child.runId,
        text: "resume through the real dispatch",
      }),
    ).toMatchObject({ status: "accepted" });
    // R3 settles an ended child with no blockers. Admit the follow-up first
    // so the real queued dispatch, rather than a terminal run, owns this work.
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      errorCode: null,
    });
  }
  for (let i = 0; i < HOST_LIMITS.queueLength.max; i++)
    await owner(t).mutation(api.agents.send, {
      threadId: root.threadId,
      text: "queued after live dispatch",
      requestKey: `live-backlog-${i}`,
    });
  // Advance the real scheduler: the root and all four child action slots are
  // suspended inside dispatch, with the remaining descendants queued behind.
  await expect
    .poll(
      async () => {
        await t.action(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        return calls("Builder").length + calls("Reviewer").length;
      },
      { timeout: 5000 },
    )
    .toBe(HOST_LIMITS.childLane.max);
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  await waitFor(t, () => calls("Main").length === 1);
  // Workflow 0.4.10 src/component/workflow.ts:403-426 recursively cancels
  // in-progress nested workflows and their Workpool actions. Prove both
  // links exist here: manually claimed assignments alone miss that budget.
  type Journal = {
    id: string;
    kind: string;
    args: { assignmentId: string };
    steps: { kind: string; inProgress: boolean; workId?: string; workflowId?: string }[];
  };
  for (const lane of ["rootWorkflow", "childWorkflow"]) {
    const journals = await workflowCall<Journal[], typeof schema>(
      t,
      `agevex/${lane}`,
      "query",
      "agevexJournal",
      "turns",
    );
    const active = [];
    for (const turn of [root, ...descendants]) {
      const row = await t.query(components.agevex.queue.execution, {
        assignmentId: turn.assignmentId,
      });
      if (
        row?.turnStatus === "running" &&
        (turn.assignmentId === root.assignmentId) === (lane === "rootWorkflow")
      )
        active.push(turn.assignmentId);
    }
    expect(active.length).toBe(lane === "rootWorkflow" ? 1 : HOST_LIMITS.childLane.max);
    for (const assignmentId of active) {
      const turn = journals.find(
        (row) => row.kind === "turn" && row.args.assignmentId === assignmentId,
      )!;
      expect(turn.steps.some((step) => step.inProgress && step.workId)).toBe(true);
      expect(
        journals.some(
          (row) =>
            row.kind === "loop" &&
            row.steps.some((step) => step.inProgress && step.workflowId === turn.id),
        ),
      ).toBe(true);
    }
  }
  const metrics = await owner(t).run(async (ctx) => {
    await ctx.runMutation(api.agents.cancel, { threadId: root.threadId });
    return ctx.meta.getTransactionMetrics();
  });
  expect(metrics.bytesRead.used).toBeLessThan(enforced.bytesRead);
  expect(metrics.documentsRead.used).toBeLessThan(enforced.documentsRead);
  expect(metrics.documentsWritten.used).toBeLessThan(enforced.documentsWritten);
  const callsAtCancel = v2.calls.length;
  held.release();
  await drain(t);
  expect(v2.calls).toHaveLength(callsAtCancel);
  for (const turn of [root, ...descendants]) {
    expect(
      await t.query(components.agevex.queue.execution, {
        assignmentId: turn.assignmentId,
      }),
    ).toMatchObject({ cancelled: true, queuedMessages: 0, turnStatus: "idle" });
    const transcript = await owner(t).query(api.agents.messages, {
      threadId: turn.threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    });
    expect(JSON.stringify(transcript)).not.toContain("late output must be fenced");
  }
  expect((await tree(t, root.threadId)).every((run) => run.status === "failed")).toBe(true);
}, 30_000);

it("message_child reaches running and idle children, rejects foreign and finished runs, and enforces eight messages", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const child = await launch(t, root, "Builder");
  // An idle child remains live only while a real R3 blocker exists.
  await launch(t, child, "Reviewer");
  const send = (target = child.runId, message = "follow-up") =>
    t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      runId: target,
      text: message,
    });
  expect(await send()).toMatchObject({ status: "accepted" });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: child.assignmentId,
    turnToken: child.turnToken,
    errorCode: null,
  });
  const resumed = await t.query(components.agevex.queue.execution, {
    assignmentId: child.assignmentId,
  });
  const claim = await t.mutation(components.agevex.queue.claim, {
    assignmentId: child.assignmentId,
    turnToken: resumed!.turnToken!,
  });
  expect(
    (
      await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: [claim!.promptMessageId],
      })
    )[0]?.text,
  ).toBe("follow-up");
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: child.assignmentId,
    turnToken: resumed!.turnToken!,
    errorCode: null,
  });
  expect(
    (await t.query(components.agevex.queue.execution, { assignmentId: child.assignmentId }))
      ?.turnStatus,
  ).toBe("idle");
  expect(await send(child.runId, "idle message")).toMatchObject({ status: "accepted" });
  for (let i = 2; i < HOST_LIMITS.messagesPerChild.max; i++)
    expect(await send()).toMatchObject({ status: "accepted" });
  expect(await send()).toMatchObject({ status: "denied", code: "MESSAGE_LIMIT" });
  const foreign = await manualRoot(t, "foreign");
  const other = await launch(t, foreign, "Reviewer");
  expect(await send(other.runId)).toMatchObject({ status: "denied", code: "FORBIDDEN" });
  await t.mutation(components.agevex.subagents.settle, {
    assignmentId: other.assignmentId,
    turnToken: other.turnToken,
    runId: other.runId,
    childResultMessageId: null,
    errorCode: "GENERATION_FAILED",
  });
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: foreign.assignmentId,
      turnToken: foreign.turnToken,
      runId: other.runId,
      text: "finished",
    }),
  ).toMatchObject({ status: "denied", code: "CHILD_FINISHED" });
  expect(await send(child.runId, "x".repeat(HOST_LIMITS.taskLength.max + 1))).toMatchObject({
    status: "denied",
    code: "TASK_LIMIT",
  });
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await owner(t).mutation(api.agents.cancel, { threadId: foreign.threadId });
  await drain(t);
});

it("the 15-descendant cap includes grandchildren and cancel fences maximum queues, messages, questions and native placeholders in one transaction", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const parent = await launch(t, root, "Builder");
  const descendants = [parent];
  for (let i = 1; i < HOST_LIMITS.activeChildrenPerRoot.max; i++)
    descendants.push(await launch(t, parent, "Reviewer"));
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "launch",
      assignmentId: parent.assignmentId,
      turnToken: parent.turnToken,
      toolCallId: "over",
      agent: "Reviewer",
      task: "too many",
    }),
  ).toMatchObject({ status: "denied", code: "ACTIVE_LIMIT" });
  expect(await tree(t, root.threadId)).toHaveLength(HOST_LIMITS.activeChildrenPerRoot.max);
  // All maxima are configured: 15 launches +83 parent messages +2 questions
  // spend the entire 100-hop budget. Per-child messages remain capped at eight.
  const followups = HOST_LIMITS.runHops.max - HOST_LIMITS.activeChildrenPerRoot.max - 2;
  for (let i = 0; i < followups; i++) {
    const child = descendants[1 + Math.floor(i / 8)];
    expect(
      await t.mutation(api.agents.coordinate, {
        op: "message",
        assignmentId: root.assignmentId,
        turnToken: root.turnToken,
        runId: child.runId,
        text: "😀".repeat(HOST_LIMITS.taskLength.max / 2),
      }),
    ).toMatchObject({ status: "accepted" });
  }
  // R2 forbids the Builder with live children from asking; two leaves spend the hops.
  for (const child of descendants.slice(-2))
    expect(
      await t.mutation(api.agents.coordinate, {
        op: "ask",
        assignmentId: child.assignmentId,
        turnToken: child.turnToken,
        question: "😀".repeat(HOST_LIMITS.taskLength.max / 2),
      }),
    ).toMatchObject({ status: "accepted" });
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      runId: descendants[descendants.length - 2].runId,
      text: "budget exhausted",
    }),
  ).toMatchObject({ status: "denied", code: "RUN_BUDGET" });
  for (let i = 1; i < HOST_LIMITS.queueLength.max; i++)
    await owner(t).mutation(api.agents.send, {
      threadId: root.threadId,
      text: "😀".repeat(LIMITS.messageLength / 2),
      requestKey: "backlog-" + i,
    });
  const placeholders: string[] = [];
  for (const turn of [root, ...descendants])
    placeholders.push(
      await nativeSave(
        t,
        turn,
        turn === root ? "Main" : turn === parent ? "Builder" : "Reviewer",
        "x".repeat(490 << 10),
        "pending",
      ),
    );
  const metrics = await owner(t).run(async (ctx) => {
    await ctx.runMutation(api.agents.cancel, { threadId: root.threadId });
    return ctx.meta.getTransactionMetrics();
  });
  expect(metrics.bytesRead.used).toBeLessThan(8 << 20);
  expect(metrics.documentsRead.used).toBeLessThan(4096);
  expect(metrics.documentsWritten.used).toBeLessThan(8000);
  for (const turn of [root, ...descendants])
    expect(
      await t.query(components.agevex.queue.execution, { assignmentId: turn.assignmentId }),
    ).toMatchObject({ cancelled: true, cancellationEpoch: 1, queuedMessages: 0 });
  await drain(t);
  for (const messageId of placeholders)
    expect(
      (await t.query(components.agent.messages.getMessagesByIds, { messageIds: [messageId] }))[0],
    ).toMatchObject({ status: "failed", error: "CANCELLED" });
  expect((await tree(t, root.threadId)).every((run) => run.status === "failed")).toBe(true);
  expect(v2.calls).toEqual([]);
}, 30_000);

it("a 15-member closed group bounds native results and large call ids, rejects extra or conflicting members, and claims one join within transaction limits", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const children = [];
  for (let i = 0; i < HOST_LIMITS.activeChildrenPerRoot.max; i++)
    children.push(
      await launch(t, root, "Reviewer", {
        group: "😀".repeat(LIMITS.groupLength / 2),
        wait: "all",
        toolCallId: "x".repeat(200 << 10) + i,
      }),
    );
  // Native duplicates text in content and its projection: 490 KiB*2 <1 MiB.
  // A transcript scan would exceed 16 MiB across this cohort. Settlement and
  // notification each read ONE recorded id, and release reads only metadata.
  for (const [i, child] of children.entries()) {
    const resultMessageId = await nativeSave(t, child, "Reviewer", `${i}:` + "x".repeat(490 << 10));
    await t.mutation(api.agents.coordinate, {
      op: "settle",
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      runId: child.runId,
      resultMessageId,
      errorCode: null,
    });
    const metrics = await t.run(async (ctx) => {
      await ctx.runMutation(api.agents.coordinate, {
        op: "notify",
        runId: child.runId,
        deliveryToken: child.deliveryToken,
      });
      return ctx.meta.getTransactionMetrics();
    });
    expect(metrics.bytesRead.used).toBeLessThan(8 << 20);
    if (i === 0) {
      const extra = {
        op: "launch" as const,
        assignmentId: root.assignmentId,
        turnToken: root.turnToken,
        agent: "Reviewer",
        task: "extra member",
        group: "😀".repeat(LIMITS.groupLength / 2),
      };
      expect(
        await t.mutation(api.agents.coordinate, {
          ...extra,
          toolCallId: "over-group",
          wait: "all",
        }),
      ).toMatchObject({ status: "denied", code: "GROUP_LIMIT" });
      expect(
        await t.mutation(api.agents.coordinate, {
          ...extra,
          toolCallId: "conflict-group",
          wait: "each",
        }),
      ).toMatchObject({ status: "denied", code: "GROUP_CONFLICT" });
    }
    const execution = await t.query(components.agevex.queue.execution, {
      assignmentId: root.assignmentId,
    });
    // Settled members cannot close membership while this launching turn is live.
    expect(execution?.queuedMessages).toBe(0);
  }
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  const execution = await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  });
  const claimed = await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: execution!.turnToken!,
  });
  expect(claimed).not.toBeNull();
  expect(
    (await t.query(components.agevex.queue.execution, { assignmentId: root.assignmentId }))
      ?.queuedMessages,
  ).toBe(0);
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "launch",
      assignmentId: root.assignmentId,
      turnToken: execution!.turnToken!,
      toolCallId: "closed",
      agent: "Reviewer",
      task: "closed",
      group: "😀".repeat(LIMITS.groupLength / 2),
      wait: "all",
    }),
  ).toMatchObject({ status: "denied", code: "GROUP_CLOSED" });
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
}, 30_000);

it("the run launch budget counts all 50 descendants across turns and runTree reads that full bounded history", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const parent = await launch(t, root, "Builder");
  for (let i = 1; i < HOST_LIMITS.runLaunches.max; i++) {
    const child = await launch(t, parent, "Reviewer");
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
      deliveryStatus: "blocked",
      parentMessageId: null,
      errorCode: "DELIVERY_FAILED",
    });
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      errorCode: null,
    });
  }
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "launch",
      assignmentId: parent.assignmentId,
      turnToken: parent.turnToken,
      toolCallId: "over-budget",
      agent: "Reviewer",
      task: "over-budget",
    }),
  ).toMatchObject({ status: "denied", code: "RUN_BUDGET" });
  expect(await tree(t, root.threadId)).toHaveLength(50);
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
}, 30_000);

it("groups with the same name are scoped to their immediate parent assignment", async () => {
  const t = setup();
  v2.steps.Main = (n) => (n === 0 ? [delegate("Builder"), delegate("Builder")] : text("root done"));
  v2.steps.Builder = (_n, args) =>
    JSON.stringify(args.prompt).includes("Reviewer completed")
      ? text("builder done")
      : [delegate("Reviewer", { group: "shared name", wait: "all" })];
  const receipt = await open(t);
  await drain(t);
  expect(calls("Builder")).toHaveLength(4);
  expect(calls("Reviewer")).toHaveLength(2);
  const rows = await tree(t, receipt.threadId);
  expect(
    new Set(rows.filter((run) => run.depth === 2).map((run) => run.parentAssignmentId)).size,
  ).toBe(2);
  expect(rows.every((run) => run.status === "completed")).toBe(true);
});

it("an all group releases independently of an unsettled group in the same run", async () => {
  const t = setup();
  const held = gate();
  v2.steps.Main = (n) =>
    n === 0
      ? [
          delegate("Reviewer", { group: "fast", wait: "all" }),
          delegate("Reviewer", { group: "slow", wait: "all" }),
        ]
      : text("joined one group");
  v2.steps.Reviewer = async (n) => {
    if (n === 1) await held.promise;
    return text(`group result ${n}`);
  };
  const receipt = await open(t);
  await waitFor(t, () => calls("Main").length === 2);
  expect((await tree(t, receipt.threadId)).some((run) => run.status === "running")).toBe(true);
  held.release();
  await drain(t);
  expect(calls("Main")).toHaveLength(3);
});

it("a parent follow-up admitted before settlement is consumed before a child can complete", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const child = await launch(t, root, "Reviewer");
  const resultMessageId = await nativeSave(t, child, "Reviewer", "early answer");
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      runId: child.runId,
      text: "please revise",
    }),
  ).toMatchObject({ status: "accepted" });
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "settle",
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      runId: child.runId,
      resultMessageId,
      errorCode: null,
    }),
  ).toMatchObject({ status: "deferred" });
  expect((await tree(t, root.threadId))[0].status).toBe("running");
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
});

it("a later user turn may message an active child of an earlier run on the same root", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const child = await launch(t, root, "Reviewer");
  await owner(t).mutation(api.agents.send, {
    threadId: root.threadId,
    text: "new request",
    requestKey: "new-request",
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  const current = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  expect(
    await t.mutation(components.agevex.queue.claim, {
      assignmentId: current._id,
      turnToken: current.turnToken!,
    }),
  ).not.toBeNull();
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: current._id,
      turnToken: current.turnToken!,
      runId: child.runId,
      text: "old child follow-up",
    }),
  ).toMatchObject({ status: "accepted" });
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
});

it("a valid native assistant message outside the recorded turn cannot impersonate its result", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const child = await launch(t, root, "Reviewer");
  await nativeSave(t, child, "Reviewer", "recorded answer");
  const { messageId } = await t.run((ctx) =>
    saveMessage(ctx, components.agent, {
      threadId: child.threadId,
      agentName: "Reviewer",
      message: { role: "assistant", content: "unrelated valid assistant" },
    }),
  );
  await t.mutation(api.agents.coordinate, {
    op: "settle",
    assignmentId: child.assignmentId,
    turnToken: child.turnToken,
    runId: child.runId,
    resultMessageId: messageId,
    errorCode: null,
  });
  const rows = await owner(t).query(api.agents.delegations, {
    threadId: root.threadId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  expect(rows.page[0]).toMatchObject({ status: "failed", errorCode: "RESULT_UNVERIFIED" });
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
});

it("a joined group needs one queue slot and resumes after a full inbox without retrying native delivery", async () => {
  const t = setup({ ...maxima, queueLength: 1 });
  const root = await manualRoot(t);
  const children = [];
  for (let i = 0; i < 3; i++)
    children.push(await launch(t, root, "Reviewer", { group: "small queue", wait: "all" }));
  await owner(t).mutation(api.agents.send, {
    threadId: root.threadId,
    text: "occupy the only slot",
    requestKey: "only-slot",
  });
  for (const [i, child] of children.entries()) {
    const resultMessageId = await nativeSave(t, child, "Reviewer", `joined result ${i}`);
    await t.mutation(api.agents.coordinate, {
      op: "settle",
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      runId: child.runId,
      resultMessageId,
      errorCode: null,
    });
    await t.mutation(api.agents.coordinate, {
      op: "notify",
      runId: child.runId,
      deliveryToken: child.deliveryToken,
    });
  }
  expect(
    (
      await owner(t).query(api.agents.delegations, {
        threadId: root.threadId,
        paginationOpts: { cursor: null, numItems: 20 },
      })
    ).page.every((run) => run.deliveryStatus === "accepted"),
  ).toBe(true);
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  let current = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: current.turnToken!,
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: current.turnToken!,
    errorCode: null,
  });
  current = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  const claimed = await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: current.turnToken!,
  });
  expect(
    (
      await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: [claimed!.promptMessageId],
      })
    )[0]?.text,
  ).toContain("joined result 2");
  for (const child of children)
    await t.mutation(api.agents.coordinate, {
      op: "notify",
      runId: child.runId,
      deliveryToken: child.deliveryToken,
    });
  expect(
    (await t.query(components.agevex.queue.execution, { assignmentId: root.assignmentId }))
      ?.queuedMessages,
  ).toBe(0);
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
});

it("cancel bounds every descendant inbox across fourteen independent maximum-launch and maximum-hop user runs", async () => {
  const t = setup(maxima);
  let root = await manualRoot(t);
  const parents = [];
  for (let p = 0; p < HOST_LIMITS.activeChildrenPerRoot.max; p++) {
    if (p) {
      await t.mutation(components.agevex.queue.finish, {
        assignmentId: root.assignmentId,
        turnToken: root.turnToken,
        errorCode: null,
      });
      await owner(t).mutation(api.agents.send, {
        threadId: root.threadId,
        text: "new independent run",
        requestKey: `independent-${p}`,
      });
      const next = (await t.query(components.agevex.queue.execution, {
        assignmentId: root.assignmentId,
      }))!;
      root = { ...root, turnToken: next.turnToken! };
      await t.mutation(components.agevex.queue.claim, {
        assignmentId: root.assignmentId,
        turnToken: root.turnToken,
      });
    }
    const parent = await launch(t, root, "Builder");
    parents.push(parent);
    // Keep one active slot for each grandchild. Fourteen parents can each
    // accumulate 49 native failure results; the last parent fills slot fifteen.
    if (p === HOST_LIMITS.activeChildrenPerRoot.max - 1) break;
    for (let i = 1; i < HOST_LIMITS.runLaunches.max; i++) {
      const child = await launch(t, parent, "Reviewer", { task: "short fixture task" });
      await t.mutation(components.agevex.subagents.settle, {
        assignmentId: child.assignmentId,
        turnToken: child.turnToken,
        runId: child.runId,
        childResultMessageId: null,
        errorCode: "GENERATION_FAILED",
      });
      await t.mutation(api.agents.coordinate, {
        op: "notify",
        runId: child.runId,
        deliveryToken: child.deliveryToken,
      });
      await t.mutation(components.agevex.queue.finish, {
        assignmentId: child.assignmentId,
        turnToken: child.turnToken,
        errorCode: null,
      });
    }
  }
  // 1 parent launch +49 grandchild launches +49 results +1 question =100
  // hops in EACH of the fourteen budgets, rather than one shared counter.
  for (const parent of parents.slice(0, -1))
    expect(
      await t.mutation(api.agents.coordinate, {
        op: "ask",
        assignmentId: parent.assignmentId,
        turnToken: parent.turnToken,
        question: "one final hop",
      }),
    ).toMatchObject({ status: "accepted" });
  for (let i = parents.length - 1; i < HOST_LIMITS.queueLength.max; i++)
    await owner(t).mutation(api.agents.send, {
      threadId: root.threadId,
      text: "full backlog",
      requestKey: `independent-backlog-${i}`,
    });
  const pending: string[] = [];
  for (const turn of [root, ...parents])
    pending.push(
      await nativeSave(
        t,
        turn,
        turn === root ? "Main" : "Builder",
        "x".repeat(490 << 10),
        "pending",
      ),
    );
  const metrics = await owner(t).run(async (ctx) => {
    await ctx.runMutation(api.agents.cancel, { threadId: root.threadId });
    return ctx.meta.getTransactionMetrics();
  });
  expect(metrics.documentsRead.used).toBeLessThan(8192);
  expect(metrics.documentsWritten.used).toBeLessThan(16000);
  expect(metrics.bytesRead.used).toBeLessThan(16 << 20);
  for (const turn of [root, ...parents])
    expect(
      await t.query(components.agevex.queue.execution, { assignmentId: turn.assignmentId }),
    ).toMatchObject({ cancelled: true, queuedMessages: 0 });
  await drain(t);
  for (const messageId of pending)
    expect(
      (await t.query(components.agent.messages.getMessagesByIds, { messageIds: [messageId] }))[0],
    ).toMatchObject({ status: "failed", error: "CANCELLED" });
  expect(v2.calls).toEqual([]);
  // This exercises fourteen independent maximum budgets (~88 s under shared
  // review load). Keep the full cancellation arithmetic covered with headroom.
}, 180_000);

it("cancelled groups cannot hide a fresh run's deferred join behind their archived members", async () => {
  const t = setup({ ...maxima, queueLength: 1 });
  let root = await manualRoot(t);
  const old: Awaited<ReturnType<typeof launch>>[] = [];
  for (let i = 0; i < HOST_LIMITS.activeChildrenPerRoot.max; i++)
    old.push(await launch(t, root, "Reviewer", { group: "old", wait: "all" }));
  for (const child of old.slice(0, -1)) {
    await t.mutation(components.agevex.subagents.settle, {
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      runId: child.runId,
      childResultMessageId: null,
      errorCode: "GENERATION_FAILED",
    });
    await t.mutation(api.agents.coordinate, {
      op: "notify",
      runId: child.runId,
      deliveryToken: child.deliveryToken,
    });
  }
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await owner(t).mutation(api.agents.send, {
    threadId: root.threadId,
    text: "fresh run",
    requestKey: "fresh-group",
  });
  const fresh = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  root = { ...root, turnToken: fresh.turnToken! };
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
  });
  const child = await launch(t, root, "Reviewer", { group: "fresh", wait: "all" });
  await owner(t).mutation(api.agents.send, {
    threadId: root.threadId,
    text: "fill queue",
    requestKey: "fill-fresh",
  });
  await t.mutation(components.agevex.subagents.settle, {
    assignmentId: child.assignmentId,
    turnToken: child.turnToken,
    runId: child.runId,
    childResultMessageId: null,
    errorCode: "GENERATION_FAILED",
  });
  await t.mutation(api.agents.coordinate, {
    op: "notify",
    runId: child.runId,
    deliveryToken: child.deliveryToken,
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  const queued = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: queued.turnToken!,
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: queued.turnToken!,
    errorCode: null,
  });
  const released = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  expect(released.turnStatus).toBe("queued");
  const claim = await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: released.turnToken!,
  });
  expect(
    (
      await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: [claim!.promptMessageId],
      })
    )[0]?.text,
  ).toContain("Reviewer failed the delegated task");
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
});

it("persisted v1 limits resume depth-two delegation and retain the default four-message bound", async () => {
  const t = setup(maxima);
  const { maxDepth, messagesPerChild, ...legacy } = maxima;
  expect(maxDepth).toBe(2);
  expect(messagesPerChild).toBe(8);
  const receipt = await t.run(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, { userId: "alice" });
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: "legacy prompt",
      userId: "alice",
    });
    return ctx.runMutation(components.agevex.queue.accept, {
      subject: "alice",
      agent: "Main",
      threadId,
      requestKey: "legacy",
      fingerprint: "legacy",
      promptMessageId: messageId,
      runTurn: await createFunctionHandle(runTurnReference()),
      limits: legacy as Omit<
        import("../src/client/index.js").Limits,
        "maxDepth" | "messagesPerChild"
      >,
    });
  });
  if (receipt.status === "rejected") throw new Error(receipt.code);
  const root = {
    assignmentId: receipt.assignmentId,
    turnToken: receipt.assignmentId + ":0",
    threadId: receipt.threadId,
  };
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
  });
  const parent = await launch(t, root, "Builder");
  const child = await launch(t, parent, "Reviewer");
  for (let i = 0; i < LIMITS.messagesPerChild; i++)
    expect(
      await t.mutation(api.agents.coordinate, {
        op: "message",
        assignmentId: root.assignmentId,
        turnToken: root.turnToken,
        runId: child.runId,
        text: "legacy follow-up",
      }),
    ).toMatchObject({ status: "accepted" });
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      runId: child.runId,
      text: "too many",
    }),
  ).toMatchObject({ status: "denied", code: "MESSAGE_LIMIT" });
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
});

it("the root epoch rejects a late native write from a child that settled immediately before cancel", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const child = await launch(t, root, "Reviewer");
  const resultMessageId = await nativeSave(t, child, "Reviewer", "finished before cancellation");
  await t.mutation(api.agents.coordinate, {
    op: "settle",
    assignmentId: child.assignmentId,
    turnToken: child.turnToken,
    runId: child.runId,
    resultMessageId,
    errorCode: null,
  });
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  // Settlement freed the active slot; the action has not released its token.
  expect(
    (await t.query(components.agevex.queue.execution, { assignmentId: child.assignmentId }))
      ?.turnStatus,
  ).toBe("running");
  await expect(
    t.run(async (ctx) =>
      ctx.runMutation(components.agevex.queue.write, {
        assignmentId: child.assignmentId,
        executionId: child.turnToken,
        cancellationEpoch: 0,
        rejectStale: true,
        handle: await createFunctionHandle(components.agent.messages.addMessages),
        args: {
          threadId: child.threadId,
          messages: [{ message: { role: "assistant", content: "must not persist" } }],
          failPendingSteps: false,
        },
      }),
    ),
  ).rejects.toThrow("CANCELLED");
  await drain(t);
});

it("a deferred older join coalesces with the newer parent answer without hiding it from Builder", async () => {
  const t = setup({ ...maxima, queueLength: 1 });
  const root = await manualRoot(t);
  const builder = await launch(t, root, "Builder");
  const reviewer = await launch(t, builder, "Reviewer", { group: "deferred", wait: "all" });
  await complete(t, reviewer, "older verified review");
  const message = (text: string) =>
    t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      runId: builder.runId,
      text,
    });
  expect(await message("pending follow-up occupies the only slot")).toMatchObject({
    status: "accepted",
  });
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "ask",
      assignmentId: builder.assignmentId,
      turnToken: builder.turnToken,
      question: "which revision after the review?",
    }),
  ).toMatchObject({ status: "accepted" });
  expect(await message("newer answer: use revision two")).toMatchObject({ status: "accepted" });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: builder.assignmentId,
    turnToken: builder.turnToken,
    errorCode: null,
  });
  v2.steps.Builder = () => text("Builder verified the answer and review");
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  await drain(t);
  expect(calls("Builder")).toHaveLength(1);
  const prompt = JSON.stringify(calls("Builder")[0].args.prompt);
  expect(prompt).toContain("older verified review");
  expect(prompt).toContain("newer answer: use revision two");
  expect((await tree(t, root.threadId)).every((run) => run.status === "completed")).toBe(true);
});

it.each([false, true])(
  "Builder's provisional final turn cannot settle before Reviewer: failed turn=%s",
  async (fail) => {
    const t = setup();
    const reviewerGate = gate();
    let builderId = "";
    v2.steps.Main = (n) =>
      n === 0
        ? [delegate("Builder")]
        : n === 1
          ? [
              call("agevex_message_child", {
                runId: builderId,
                text: "report progress before the review",
              }),
            ]
          : text("Main finished");
    v2.steps.Builder = (n) => {
      if (n === 0) return [delegate("Reviewer")];
      if (n === 1) {
        if (fail) throw new Error("provisional generation failed");
        return text("provisional output before the review");
      }
      return text("verified last Builder turn after the review");
    };
    v2.steps.Reviewer = async () => {
      await reviewerGate.promise;
      return text("Reviewer finally finished");
    };
    const root = await open(t);
    await waitFor(t, () => calls("Reviewer").length === 1);
    const builderRun = (await tree(t, root.threadId)).find((run) => run.agent === "Builder")!;
    builderId = builderRun.runId;
    await owner(t).mutation(api.agents.send, {
      threadId: root.threadId,
      text: "request progress",
      requestKey: "progress",
    });
    await waitFor(t, () => calls("Builder").length === 2);
    await expect
      .poll(async () => {
        await tick(t);
        return t.query(components.agevex.queue.execution, {
          assignmentId: builderRun.childAssignmentId!,
        });
      })
      .toMatchObject({ turnStatus: "idle" });
    const pending = await owner(t).query(api.agents.delegations, {
      threadId: root.threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    });
    expect(pending.page.find((run) => run.runId === builderId)?.status).toBe("running");
    reviewerGate.release();
    await drain(t);
    expect(calls("Builder")).toHaveLength(3);
    expect(JSON.stringify(calls("Builder")[2].args.prompt)).toContain("Reviewer finally finished");
    expect(JSON.stringify(calls("Main")[calls("Main").length - 1].args.prompt)).toContain(
      "verified last Builder turn after the review",
    );
    const runs = (
      await owner(t).query(api.agents.delegations, {
        threadId: root.threadId,
        paginationOpts: { cursor: null, numItems: 20 },
      })
    ).page;
    expect(
      runs.every((run) => run.status === "completed" && run.deliveryStatus === "accepted"),
    ).toBe(true);
    const builderResult = runs.find((run) => run.runId === builderId)!;
    expect(
      (
        await t.query(components.agent.messages.getMessagesByIds, {
          messageIds: [builderResult.resultMessageId!],
        })
      )[0]?.text,
    ).toContain("verified last Builder turn after the review");
  },
);

it("an answer fits an asking child's full length-one follow-up inbox and the child completes", async () => {
  const t = setup({ ...maxima, queueLength: 1 });
  const root = await manualRoot(t);
  const child = await launch(t, root, "Reviewer");
  const message = (text: string) =>
    t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      runId: child.runId,
      text,
    });
  expect(await message("queued follow-up")).toMatchObject({ status: "accepted" });
  expect(await message("ordinary overflow")).toMatchObject({
    status: "denied",
    code: "QUEUE_LIMIT",
  });
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "ask",
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      question: "answer needed?",
    }),
  ).toMatchObject({ status: "accepted" });
  expect(await message("reserved answer")).toMatchObject({ status: "accepted" });
  expect(
    await t.query(components.agevex.queue.execution, { assignmentId: child.assignmentId }),
  ).toMatchObject({ queuedMessages: 2 });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: child.assignmentId,
    turnToken: child.turnToken,
    errorCode: null,
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  await drain(t);
  expect(calls("Reviewer")).toHaveLength(1);
  expect(JSON.stringify(calls("Reviewer")[0].args.prompt)).toContain("reserved answer");
  expect((await tree(t, root.threadId))[0].status).toBe("completed");
});

it("a newer each result cannot overtake an older each result from another request budget", async () => {
  const t = setup(maxima);
  let root = await manualRoot(t);
  const older = await launch(t, root, "Reviewer");
  const slow = await launch(t, root, "Reviewer");
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  await owner(t).mutation(api.agents.send, {
    threadId: root.threadId,
    text: "second budget",
    requestKey: "second",
  });
  let current = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  root = { ...root, turnToken: current.turnToken! };
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
  });
  const newer = await launch(t, root, "Reviewer");
  await complete(t, older, "older each must run first");
  await complete(t, newer, "newer each must run second");
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  for (const expected of ["older each must run first", "newer each must run second"]) {
    current = (await t.query(components.agevex.queue.execution, {
      assignmentId: root.assignmentId,
    }))!;
    const claimed = await t.mutation(components.agevex.queue.claim, {
      assignmentId: root.assignmentId,
      turnToken: current.turnToken!,
    });
    expect(
      (
        await t.query(components.agent.messages.getMessagesByIds, {
          messageIds: [claimed!.promptMessageId],
        })
      )[0]?.text,
    ).toContain(expected);
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: root.assignmentId,
      turnToken: current.turnToken!,
      errorCode: null,
    });
  }
  await complete(t, slow, "last sibling");
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
});

it("fifteen older unreleased group members cannot hide a ready group in the same epoch", async () => {
  const t = setup({ ...maxima, queueLength: 1 });
  const root = await manualRoot(t);
  const old: Awaited<ReturnType<typeof launch>>[] = [];
  for (let i = 0; i < HOST_LIMITS.activeChildrenPerRoot.max; i++)
    old.push(await launch(t, root, "Reviewer", { group: "older incomplete cohort", wait: "all" }));
  for (const child of old.slice(0, -1)) {
    await t.mutation(api.agents.coordinate, {
      op: "settle",
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      runId: child.runId,
      errorCode: "GENERATION_FAILED",
    });
    await t.mutation(api.agents.coordinate, {
      op: "notify",
      runId: child.runId,
      deliveryToken: child.deliveryToken,
    });
  }
  const sliceMessage = await nativeSave(t, root, "Main", "close the old cohort");
  await t.mutation(components.agevex.queue.continueTurn, {
    assignmentId: root.assignmentId,
    executionId: root.turnToken,
    cancellationEpoch: 0,
    messageId: sliceMessage,
  });
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    sliceId: "fresh-cohort-slice",
  });
  const fresh = await launch(t, root, "Reviewer", {
    group: "ready beyond the old prefix",
    wait: "all",
  });
  await owner(t).mutation(api.agents.send, {
    threadId: root.threadId,
    text: "occupy the only slot",
    requestKey: "history-full",
  });
  await complete(t, fresh, "the ready group beyond fifteen historical rows");
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  let current = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: current.turnToken!,
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: current.turnToken!,
    errorCode: null,
  });
  current = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  expect(current.turnStatus).toBe("queued");
  const claimed = await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: current.turnToken!,
  });
  expect(
    (
      await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: [claimed!.promptMessageId],
      })
    )[0]?.text,
  ).toContain("the ready group beyond fifteen historical rows");
  expect(
    (await tree(t, root.threadId)).find((run) => run.runId === old[old.length - 1].runId)?.status,
  ).toBe("running");
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
});

it("cancel fences a reserved answer beyond a full follow-up queue within transaction limits", async () => {
  const t = setup({ ...maxima, queueLength: 1 });
  const root = await manualRoot(t);
  const child = await launch(t, root, "Reviewer");
  const message = (text: string) =>
    t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      runId: child.runId,
      text,
    });
  await message("full follow-up queue");
  await t.mutation(api.agents.coordinate, {
    op: "ask",
    assignmentId: child.assignmentId,
    turnToken: child.turnToken,
    question: "reserve an answer slot",
  });
  expect(await message("answer in the extra slot")).toMatchObject({ status: "accepted" });
  // A second question cannot reserve a second extra answer slot before consumption.
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "ask",
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      question: "too soon",
    }),
  ).toMatchObject({ status: "denied", code: "QUEUE_LIMIT" });
  const metrics = await owner(t).run(async (ctx) => {
    await ctx.runMutation(api.agents.cancel, { threadId: root.threadId });
    return ctx.meta.getTransactionMetrics();
  });
  expect(metrics.documentsRead.used).toBeLessThan(8192);
  expect(metrics.documentsWritten.used).toBeLessThan(16000);
  expect(metrics.bytesRead.used).toBeLessThan(16 << 20);
  expect(
    await t.query(components.agevex.queue.execution, { assignmentId: child.assignmentId }),
  ).toMatchObject({ cancelled: true, queuedMessages: 0 });
  await drain(t);
  expect(calls("Reviewer")).toHaveLength(0);
});

it("Builder cannot settle in the gap between Reviewer's terminal state and its native result delivery", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const builder = await launch(t, root, "Builder");
  const reviewer = await launch(t, builder, "Reviewer");
  const reviewerResult = await nativeSave(
    t,
    reviewer,
    "Reviewer",
    "review delivered after settlement",
  );
  await t.mutation(api.agents.coordinate, {
    op: "settle",
    assignmentId: reviewer.assignmentId,
    turnToken: reviewer.turnToken,
    runId: reviewer.runId,
    resultMessageId: reviewerResult,
    errorCode: null,
  });
  // R2 also fences terminal-but-undelivered children so asking never receives a late result.
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "ask",
      assignmentId: builder.assignmentId,
      turnToken: builder.turnToken,
      question: "cannot ask before the pending result arrives",
    }),
  ).toMatchObject({ status: "denied", code: "ASK_WITH_CHILDREN" });
  const provisional = await nativeSave(t, builder, "Builder", "provisional before delivery");
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "settle",
      assignmentId: builder.assignmentId,
      turnToken: builder.turnToken,
      runId: builder.runId,
      resultMessageId: provisional,
      errorCode: null,
    }),
  ).toMatchObject({ status: "deferred" });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: builder.assignmentId,
    turnToken: builder.turnToken,
    errorCode: null,
  });
  expect((await tree(t, root.threadId))[0].status).toBe("running");
  await t.mutation(api.agents.coordinate, {
    op: "notify",
    runId: reviewer.runId,
    deliveryToken: reviewer.deliveryToken,
  });
  v2.steps.Builder = () => text("last turn verified after native delivery");
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: reviewer.assignmentId,
    turnToken: reviewer.turnToken,
    errorCode: null,
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  await drain(t);
  expect(calls("Builder")).toHaveLength(1);
  expect(JSON.stringify(calls("Builder")[0].args.prompt)).toContain(
    "review delivered after settlement",
  );
  expect(JSON.stringify(calls("Main")[0].args.prompt)).toContain(
    "last turn verified after native delivery",
  );
});

it("a claim drains fifty ready deferred groups at the maximum launch and hop budgets within transaction limits", async () => {
  const t = setup({ ...maxima, queueLength: 1 });
  const root = await manualRoot(t);
  for (let i = 0; i < HOST_LIMITS.runLaunches.max; i++) {
    const child = await launch(t, root, "Reviewer", { group: "cohort-" + i, wait: "all" });
    await complete(t, child, "ready group " + i);
  }
  await owner(t).mutation(api.agents.send, {
    threadId: root.threadId,
    text: "full queue delays every ready cohort",
    requestKey: "fifty-groups-full",
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  let current = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: root.assignmentId,
    turnToken: current.turnToken!,
  });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: current.turnToken!,
    errorCode: null,
  });
  current = (await t.query(components.agevex.queue.execution, {
    assignmentId: root.assignmentId,
  }))!;
  const { claimed, metrics } = await t.run(async (ctx) => {
    const claimed = await ctx.runMutation(components.agevex.queue.claim, {
      assignmentId: root.assignmentId,
      turnToken: current.turnToken!,
    });
    return { claimed, metrics: await ctx.meta.getTransactionMetrics() };
  });
  expect(
    (
      await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: [claimed!.promptMessageId],
      })
    )[0]?.text,
  ).toContain("ready group 49");
  expect(metrics.bytesRead.used).toBeLessThan(8 << 20);
  expect(metrics.documentsRead.used).toBeLessThan(4096);
  expect(metrics.documentsWritten.used).toBeLessThan(8000);
  expect(
    await t.query(components.agevex.queue.execution, { assignmentId: root.assignmentId }),
  ).toMatchObject({ queuedMessages: 0 });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: current.turnToken!,
    errorCode: null,
  });
  expect(
    await t.query(components.agevex.queue.execution, { assignmentId: root.assignmentId }),
  ).toMatchObject({ turnStatus: "idle", queuedMessages: 0 });
  await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
  await drain(t);
}, 30_000);

it.each(
  (["each", "all"] as const).flatMap((wait) =>
    (["failed", "blocked"] as const).flatMap((deliveryStatus) =>
      (["verified", "missing", "failed"] as const).map((result) => ({
        wait,
        deliveryStatus,
        result,
      })),
    ),
  ),
)(
  "an idle Builder settles after Reviewer delivery: wait=$wait delivery=$deliveryStatus result=$result",
  async ({ wait, deliveryStatus, result }) => {
    const t = setup(maxima);
    const root = await manualRoot(t);
    const builder = await launch(t, root, "Builder");
    const reviewer = await launch(t, builder, "Reviewer", { group: "review", wait });
    const resultMessageId =
      result === "verified"
        ? await nativeSave(t, builder, "Builder", "verified provisional Builder result")
        : undefined;
    expect(
      await t.mutation(api.agents.coordinate, {
        op: "settle",
        assignmentId: builder.assignmentId,
        turnToken: builder.turnToken,
        runId: builder.runId,
        resultMessageId,
        errorCode: result === "failed" ? "GENERATION_FAILED" : null,
      }),
    ).toMatchObject({ status: "deferred" });
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: builder.assignmentId,
      turnToken: builder.turnToken,
      errorCode: null,
    });
    await t.mutation(components.agevex.subagents.settle, {
      assignmentId: reviewer.assignmentId,
      turnToken: reviewer.turnToken,
      runId: reviewer.runId,
      childResultMessageId: null,
      errorCode: "GENERATION_FAILED",
    });
    // The terminal-to-delivery gap remains fenced even after Builder ended.
    expect((await tree(t, root.threadId))[0].status).toBe("running");
    await t.mutation(components.agevex.subagents.deliver, {
      runId: reviewer.runId,
      deliveryToken: reviewer.deliveryToken,
      deliveryStatus,
      parentMessageId: null,
      errorCode: deliveryStatus === "failed" ? "DELIVERY_FAILED" : "AUTHORIZATION_DENIED",
    });
    // No scheduler tick: the last blocker and settlement commit together,
    // including an all cohort that releases without any accepted messages.
    expect((await tree(t, root.threadId))[0].status).toBe(
      result === "verified" ? "completed" : "failed",
    );
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: reviewer.assignmentId,
      turnToken: reviewer.turnToken,
      errorCode: null,
    });
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      errorCode: null,
    });
    await drain(t);
    expect(calls("Builder")).toHaveLength(0);
    expect(calls("Main")).toHaveLength(1);
    expect(JSON.stringify(calls("Main")[0].args.prompt)).toContain(
      result === "verified"
        ? "verified provisional Builder result"
        : result === "failed"
          ? "GENERATION_FAILED"
          : "RESULT_UNVERIFIED",
    );
    expect(
      (
        await owner(t).query(api.agents.delegations, {
          threadId: root.threadId,
          paginationOpts: { cursor: null, numItems: 20 },
        })
      ).page.find((run) => run.runId === builder.runId),
    ).toMatchObject({
      deliveryStatus: "accepted",
      errorCode:
        result === "verified"
          ? null
          : result === "failed"
            ? "GENERATION_FAILED"
            : "RESULT_UNVERIFIED",
    });
  },
  30_000,
);

it.each(["each", "all"] as const)(
  "a two-hop Main → Builder → Reviewer run settles every idle ancestor with wait=%s",
  async (wait) => {
    const t = setup({ runHops: 2 });
    v2.steps.Main = (n) => (n === 0 ? [delegate("Builder")] : text("Main finished"));
    v2.steps.Builder = (n) =>
      n === 0 ? [delegate("Reviewer", { group: "review", wait })] : text("Builder finished");
    const root = await open(t);
    await drain(t);
    const runs = (
      await owner(t).query(api.agents.delegations, {
        threadId: root.threadId,
        paginationOpts: { cursor: null, numItems: 20 },
      })
    ).page;
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => ["completed", "failed"].includes(run.status))).toBe(true);
    expect(runs.every((run) => run.deliveryStatus !== "pending")).toBe(true);
    expect(
      (await owner(t).query(api.agents.activity, { threadId: root.threadId })).subagents.active,
    ).toBe(0);
  },
);

it.each([1, HOST_LIMITS.queueLength.max])(
  "pre-claim dispatch failures retire once, preserve queue capacity %s, and cancel leaves no inbox rows",
  async (queueLength) => {
    const t = setup({ ...maxima, queueLength }, true);
    let root = await manualRoot(t);
    const queuedWork = () =>
      t.query(
        componentsGeneric().agevex.agevexTest.queuedWork as unknown as FunctionReference<
          "query",
          "internal",
          {},
          { inbox: { assignmentId: string }[] }
        >,
        {},
      );
    const queued = async () => {
      const receipt = await t.mutation(api.agents.coordinate, {
        op: "launch",
        assignmentId: root.assignmentId,
        turnToken: root.turnToken,
        toolCallId: crypto.randomUUID(),
        agent: "Reviewer",
        task: "dispatch fails before claim",
      });
      if (receipt?.status !== "queued") throw new Error(JSON.stringify(receipt));
      const run = (await tree(t, root.threadId)).find((run) => run.runId === receipt.runId)!;
      const row = (await t.query(components.agevex.queue.execution, {
        assignmentId: run.childAssignmentId!,
      }))!;
      return { run, row };
    };
    const message = (runId: string) =>
      t.mutation(api.agents.coordinate, {
        op: "message",
        assignmentId: root.assignmentId,
        turnToken: root.turnToken,
        runId,
        text: "follow-up",
      });
    const failed = [];
    for (let i = 0; i < 5; i++) {
      const { run, row } = await queued();
      const args = {
        assignmentId: row._id,
        executionId: row.turnToken!,
        sliceId: row.turnToken! + "/0",
      };
      const dispatch = componentsGeneric().agevex.worker.dispatch as unknown as FunctionReference<
        "action",
        "internal",
        typeof args,
        null
      >;
      await t.action(dispatch, args);
      // Duplicate dispatch completion must neither decrement nor escalate again.
      await t.action(dispatch, args);
      const current = (await t.query(components.agevex.queue.execution, {
        assignmentId: row._id,
      }))!;
      expect(current.queuedMessages).toBe(0);
      expect(
        (await queuedWork()).inbox.filter((item) => item.assignmentId === row._id),
      ).toHaveLength(0);
      const terminal = (
        await owner(t).query(api.agents.delegations, {
          threadId: root.threadId,
          paginationOpts: { cursor: null, numItems: 50 },
        })
      ).page.find((entry) => entry.runId === run.runId)!;
      expect(terminal).toMatchObject({
        status: "failed",
        errorCode: "EXECUTION_AMBIGUOUS",
        deliveryStatus: "pending",
      });
      expect(terminal.events.filter((event) => event.phase === "failed")).toHaveLength(1);
      expect(await message(run.runId)).toMatchObject({ status: "denied" });
      failed.push(run.runId);
    }
    // All active slots and the root queue are filled at host maxima. The real
    // inbox contains the counter plus one reserved head per queued assignment.
    const live = [];
    for (let i = 0; i < HOST_LIMITS.activeChildrenPerRoot.max; i++) {
      if (i) {
        await t.mutation(components.agevex.queue.finish, {
          assignmentId: root.assignmentId,
          turnToken: root.turnToken,
          errorCode: null,
        });
        await owner(t).mutation(api.agents.send, {
          threadId: root.threadId,
          text: "independent child budget",
          requestKey: "live-child-" + i,
        });
        const current = (await t.query(components.agevex.queue.execution, {
          assignmentId: root.assignmentId,
        }))!;
        root = { ...root, turnToken: current.turnToken! };
        expect(
          await t.mutation(components.agevex.queue.claim, {
            assignmentId: root.assignmentId,
            turnToken: root.turnToken,
          }),
        ).not.toBeNull();
      }
      const child = await queued();
      live.push(child);
      expect(
        await t.mutation(components.agevex.queue.claim, {
          assignmentId: child.row._id,
          turnToken: child.row.turnToken!,
        }),
      ).not.toBeNull();
      for (let n = 0; n < Math.min(queueLength, HOST_LIMITS.messagesPerChild.max); n++)
        expect(await message(child.run.runId)).toMatchObject({ status: "accepted" });
      expect(await message(child.run.runId)).toMatchObject({ status: "denied" });
      await t.mutation(components.agevex.queue.finish, {
        assignmentId: child.row._id,
        turnToken: child.row.turnToken!,
        errorCode: null,
      });
    }
    for (let n = 0; n < queueLength; n++)
      await owner(t).mutation(api.agents.send, {
        threadId: root.threadId,
        text: "root backlog",
        requestKey: "backlog-" + n,
      });
    const inbox = (await queuedWork()).inbox;
    for (const assignmentId of [root.assignmentId, ...live.map(({ row }) => row._id)]) {
      const row = (await t.query(components.agevex.queue.execution, { assignmentId }))!;
      expect(row.queuedMessages).toBe(
        inbox.filter((item) => item.assignmentId === assignmentId).length - (row.inboxId ? 1 : 0),
      );
    }
    await owner(t).mutation(api.agents.cancel, { threadId: root.threadId });
    expect((await queuedWork()).inbox).toEqual([]);
    await drain(t);
    const runs = (
      await owner(t).query(api.agents.delegations, {
        threadId: root.threadId,
        paginationOpts: { cursor: null, numItems: 50 },
      })
    ).page;
    for (const runId of failed)
      expect(runs.find((run) => run.runId === runId)).toMatchObject({
        status: "failed",
        errorCode: "ROOT_UNAVAILABLE",
        deliveryStatus: "blocked",
      });
    expect(calls("Reviewer")).toHaveLength(0);
  },
  30_000,
);

it("an ended Builder releases every empty all cohort at the maximum launch budget before settling", async () => {
  const t = setup(maxima);
  const root = await manualRoot(t);
  const builder = await launch(t, root, "Builder");
  for (let i = 1; i < HOST_LIMITS.runLaunches.max; i++) {
    const reviewer = await launch(t, builder, "Reviewer", { group: "empty-" + i, wait: "all" });
    await t.mutation(components.agevex.subagents.settle, {
      assignmentId: reviewer.assignmentId,
      turnToken: reviewer.turnToken,
      runId: reviewer.runId,
      childResultMessageId: null,
      errorCode: "GENERATION_FAILED",
    });
    await t.mutation(components.agevex.subagents.deliver, {
      runId: reviewer.runId,
      deliveryToken: reviewer.deliveryToken,
      deliveryStatus: "failed",
      parentMessageId: null,
      errorCode: "DELIVERY_FAILED",
    });
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: reviewer.assignmentId,
      turnToken: reviewer.turnToken,
      errorCode: null,
    });
  }
  const resultMessageId = await nativeSave(
    t,
    builder,
    "Builder",
    "verified result after empty cohorts",
  );
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "settle",
      assignmentId: builder.assignmentId,
      turnToken: builder.turnToken,
      runId: builder.runId,
      resultMessageId,
      errorCode: null,
    }),
  ).toMatchObject({ status: "deferred" });
  const metrics = await t.run(async (ctx) => {
    await ctx.runMutation(components.agevex.queue.finish, {
      assignmentId: builder.assignmentId,
      turnToken: builder.turnToken,
      errorCode: null,
    });
    return ctx.meta.getTransactionMetrics();
  });
  expect(metrics.bytesRead.used).toBeLessThan(8 << 20);
  expect(metrics.documentsRead.used).toBeLessThan(4096);
  expect(metrics.documentsWritten.used).toBeLessThan(8000);
  expect((await tree(t, root.threadId))[0].status).toBe("completed");
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: root.assignmentId,
    turnToken: root.turnToken,
    errorCode: null,
  });
  await drain(t);
  expect(calls("Builder")).toHaveLength(0);
  expect(calls("Main")).toHaveLength(1);
  expect(JSON.stringify(calls("Main")[0].args.prompt)).toContain(
    "verified result after empty cohorts",
  );
});

it.each(
  (["answer", "respond"] as const).flatMap((response) =>
    (["before", "after"] as const).map((delivery) => ({ response, delivery })),
  ),
)(
  "$response resumes a child before R3 can settle its provisional result with delivery=$delivery",
  async ({ response, delivery }) => {
    const t = setup(maxima);
    const root = await manualRoot(t);
    const child = await launch(t, root, "Builder");
    const descendant = await launch(t, child, "Reviewer");
    const resultMessageId = await nativeSave(
      t,
      child,
      "Builder",
      "provisional result before pause",
    );
    expect(
      await t.mutation(api.agents.coordinate, {
        op: "settle",
        assignmentId: child.assignmentId,
        turnToken: child.turnToken,
        runId: child.runId,
        resultMessageId,
        errorCode: null,
      }),
    ).toMatchObject({ status: "deferred" });
    await t.run(async (ctx) =>
      ctx.runMutation(components.agevex.queue.write, {
        assignmentId: child.assignmentId,
        executionId: child.turnToken,
        cancellationEpoch: 0,
        handle: await createFunctionHandle(components.agent.messages.addMessages),
        nativeMessages: {
          getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
          finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
        },
        deferredTools: response === "answer" ? ["askHuman"] : [],
        args: {
          threadId: child.threadId,
          agentName: "Builder",
          failPendingSteps: false,
          messages: [
            {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "r3-question",
                    toolName: "askHuman",
                    input: { question: "Which revision?" },
                  },
                  ...(response === "respond"
                    ? [
                        {
                          type: "tool-approval-request",
                          approvalId: "r3-approval",
                          toolCallId: "r3-question",
                        },
                      ]
                    : []),
                ],
              },
            },
          ],
        },
      }),
    );
    const failDelivery = async () => {
      await t.mutation(components.agevex.subagents.settle, {
        assignmentId: descendant.assignmentId,
        turnToken: descendant.turnToken,
        runId: descendant.runId,
        childResultMessageId: null,
        errorCode: "GENERATION_FAILED",
      });
      // Clearing the last descendant is an R3 re-check without new inbox work.
      await t.mutation(components.agevex.subagents.deliver, {
        runId: descendant.runId,
        deliveryToken: descendant.deliveryToken,
        deliveryStatus: "failed",
        parentMessageId: null,
        errorCode: "DELIVERY_FAILED",
      });
      await t.mutation(components.agevex.queue.finish, {
        assignmentId: descendant.assignmentId,
        turnToken: descendant.turnToken,
        errorCode: null,
      });
    };
    const resume = () =>
      response === "answer"
        ? owner(t).mutation(api.agents.answer, {
            threadId: child.threadId,
            toolCallId: "r3-question",
            text: "Use the answered revision",
          })
        : owner(t).mutation(api.agents.respond, {
            threadId: child.threadId,
            approvalId: "r3-approval",
            approved: false,
          });
    if (delivery === "before") await failDelivery();
    expect((await tree(t, root.threadId))[0].status).toBe("running");
    const receipt = await resume();
    expect(await resume()).toEqual(receipt);
    if (delivery === "after") await failDelivery();
    expect((await tree(t, root.threadId))[0].status).toBe("running");
    expect(
      await t.query(components.agevex.queue.execution, { assignmentId: child.assignmentId }),
    ).toMatchObject({ turnStatus: "queued", approvalBlocked: false, queuedMessages: 0 });
    v2.steps.Builder = () => text("final result after response");
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      errorCode: null,
    });
    await drain(t);
    expect(calls("Builder")).toHaveLength(1);
    expect(JSON.stringify(calls("Builder")[0].args.prompt)).toContain(
      response === "answer" ? "Use the answered revision" : "execution-denied",
    );
    expect(JSON.stringify(calls("Main")[0].args.prompt)).toContain("final result after response");
    expect((await tree(t, root.threadId))[0].status).toBe("completed");
    // Replaying after claim consumed the anchor cannot enqueue or settle again.
    expect(await resume()).toEqual(receipt);
    await drain(t);
    expect(calls("Builder")).toHaveLength(1);
    expect(calls("Main")).toHaveLength(1);
  },
);

it.each([1, HOST_LIMITS.messagesPerChild.max])(
  "a deferred child answer uses reserved capacity at queueLength=%s and stays visible when FIFO heads coalesce",
  async (queueLength) => {
    const t = setup({ ...maxima, queueLength });
    const root = await manualRoot(t);
    const child = await launch(t, root, "Builder");
    const descendant = await launch(t, child, "Reviewer");
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: child.assignmentId,
      turnToken: child.turnToken,
      errorCode: null,
    });
    await complete(t, descendant, "review before deferred question");
    const current = (await t.query(components.agevex.queue.execution, {
      assignmentId: child.assignmentId,
    }))!;
    expect(current.turnOrigin).toBe("subagent_result");
    await t.mutation(components.agevex.queue.claim, {
      assignmentId: child.assignmentId,
      turnToken: current.turnToken!,
    });
    // Fill the ordinary queue while the result-triggered turn is running. The
    // eventual answer is control traffic and must not need another regular slot.
    for (let index = 0; index < queueLength; index++)
      expect(
        await t.mutation(api.agents.coordinate, {
          op: "message",
          assignmentId: root.assignmentId,
          turnToken: root.turnToken,
          runId: child.runId,
          text: `queued parent follow-up ${index}`,
        }),
      ).toMatchObject({ status: "accepted" });
    await t.run(async (ctx) =>
      ctx.runMutation(components.agevex.queue.write, {
        assignmentId: child.assignmentId,
        executionId: current.turnToken!,
        cancellationEpoch: current.cancellationEpoch,
        handle: await createFunctionHandle(components.agent.messages.addMessages),
        nativeMessages: {
          getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
          finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
        },
        deferredTools: ["askHuman"],
        args: {
          threadId: child.threadId,
          promptMessageId: current.promptMessageId,
          failPendingSteps: false,
          messages: [
            {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "reserved-deferred-question",
                    toolName: "askHuman",
                    input: { question: "Which revision?" },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(
      await t.query(components.agevex.queue.execution, { assignmentId: child.assignmentId }),
    ).toMatchObject({ approvalBlocked: true, queuedMessages: queueLength + 1 });
    expect((await tree(t, root.threadId)).find((run) => run.runId === child.runId)?.status).toBe(
      "running",
    );
    await owner(t).mutation(api.agents.answer, {
      threadId: child.threadId,
      toolCallId: "reserved-deferred-question",
      text: "Use the final revision from this deferred answer",
    });
    v2.steps.Builder = () => text("Builder completed after the deferred answer");
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: root.assignmentId,
      turnToken: root.turnToken,
      errorCode: null,
    });
    await drain(t);
    expect(calls("Builder")).toHaveLength(1);
    const prompt = JSON.stringify(calls("Builder")[0].args.prompt);
    expect(prompt).toContain("Use the final revision from this deferred answer");
    for (let index = 0; index < queueLength; index++)
      expect(prompt).toContain(`queued parent follow-up ${index}`);
    expect((await tree(t, root.threadId)).every((run) => run.status === "completed")).toBe(true);
  },
);
