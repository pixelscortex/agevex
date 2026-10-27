import { requireReceipt } from "./receipt.js";
// Bounded asynchronous delegation: Main -> Researcher -> Main.
//
// Every case runs against the real registered coordinator, the real component
// mutations and the native Agent transcripts, with mock models only. Nothing
// here contacts a provider, reads a key or reaches the network.
import { failLoop, finalizeFailure } from "./failure.fixture.js";
import { it, expect, vi, afterEach, beforeEach } from "vite-plus/test";
import { createThread, listMessages, saveMessage } from "@convex-dev/agent";
import { createFunctionHandle } from "convex/server";
import { setup, api, components, state } from "./setup.js";
import { delegationsQuery, coordinateReference, releaseChild } from "./host.js";
import { LIMITS } from "../src/component/limits.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// Both real Workflow lanes have several control steps per turn; let the
// scheduler settle their bounded handoffs before checking final state.
const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 2000);

type Convex = ReturnType<typeof setup>;
type RunView = {
  runId: string;
  agent: string;
  status: string;
  deliveryStatus: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  deliveryAt: number | null;
  resultMessageId: string | null;
  errorCode: string | null;
  events: { runId: string; agent: string; phase: string; at: number; errorCode: string | null }[];
};

const open = (t: Convex, prompt = "research this", requestKey = "r1") =>
  t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.open, {
      agent: "Main",
      prompt,
      requestKey,
    })
    .then(requireReceipt);

const runs = (t: Convex, threadId: string, numItems = 20, cursor: string | null = null) =>
  t
    .withIdentity({ subject: "alice" })
    .query(delegationsQuery, { threadId, paginationOpts: { cursor, numItems } }) as Promise<{
    page: RunView[];
    isDone: boolean;
    continueCursor: string;
  }>;

const texts = async (t: Convex, threadId: string) => {
  const page = await t
    .withIdentity({ subject: "alice" })
    .query(api.agents.messages, { threadId, paginationOpts: { cursor: null, numItems: 20 } });

  return page.page.map((m: { text: string }) => m.text);
};

/**
 * Tool results exactly as the native transcript stored them. A delegation
 * denial is a tool result, not assistant text, so it is read from here.
 */
const toolOutputs = async (t: Convex, threadId: string) => {
  const page = await t
    .withIdentity({ subject: "alice" })
    .query(api.agents.messages, { threadId, paginationOpts: { cursor: null, numItems: 20 } });

  return page.page
    .flatMap((m: { parts: { type: string }[] }) => m.parts)
    .filter((part: { type: string }) => part.type.startsWith("tool-"))
    .map((part: unknown) => JSON.stringify(part));
};

const activity = (t: Convex, threadId: string) =>
  t.withIdentity({ subject: "alice" }).query(api.agents.activity, { threadId }) as Promise<{
    turnStatus: string;
    queuedMessages: number;
    errorCode: string | null;
    subagents: { active: number; history: number; total: number };
  }>;

/**
 * Child linkage the real `turns.slices.claim` returns for a delegated turn. Used to
 * prove that no stale or foreign capability can settle or deliver a run.
 */
type ClaimedChild = {
  runId: string;
  agent: string;
  rootAgent: string;
  actorAgent: string;
  subject: string;
  rootAssignmentId: string;
  rootThreadId: string;
  childThreadId: string;
  deliveryToken: string;
};

/**
 * Reserve and attach one child against a root turn that the caller already owns.
 *
 * Drives the same real pieces the coordinator does — a native thread and task
 * message save plus `reserve` and `attach` in one transaction — so the test owns
 * the child thread id and can look its assignment up through the public
 * `turns.send.assignment` projection instead of reaching into component state. It
 * neither claims nor releases the root turn, so a test can hold one root turn
 * open across several launches.
 */
async function reserveAndAttachChild(
  t: Convex,
  rootTurn: { assignmentId: string; turnToken: string },
  toolCallId = "manual-launch",
) {
  let childRunId = "";

  const childThreadId = await t.run(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, { userId: "alice" });

    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      prompt: "one bounded task",
      userId: "alice",
    });

    const reserved = await ctx.runMutation(components.agevex.subagents.launch.reserve, {
      ...rootTurn,
      toolCallId,
      agent: "Researcher",
      payloadFingerprint: toolCallId,
      coordinateHandle: await createFunctionHandle(coordinateReference()),
    });

    if (reserved.kind !== "reserved") throw new Error(`RESERVE_${reserved.kind}`);

    await ctx.runMutation(components.agevex.subagents.launch.attach, {
      runId: reserved.runId,
      childThreadId: threadId,
      promptMessageId: messageId,
    });

    childRunId = reserved.runId;

    return threadId;
  });

  const child = await t.run((ctx) =>
    ctx.runQuery(components.agevex.turns.send.assignment, { threadId: childThreadId }),
  );

  if (!child) throw new Error("CHILD_ASSIGNMENT_MISSING");

  return {
    runId: childRunId,
    childThreadId,
    childTurn: { assignmentId: child.assignmentId, turnToken: `${child.assignmentId}:0` },
  };
}

/**
 * Claim one root turn, launch one child on it and hand the turn straight back,
 * exactly as a finished root turn would. No model runs on it and no timer is
 * left behind.
 */
async function launchChild(t: Convex, rootAssignmentId: string) {
  const rootTurn = { assignmentId: rootAssignmentId, turnToken: `${rootAssignmentId}:0` };

  await t.mutation(components.agevex.turns.slices.claim, rootTurn);
  const child = await reserveAndAttachChild(t, rootTurn);

  await t.mutation(components.agevex.turns.slices.finish, { ...rootTurn, errorCode: null });

  return child;
}

/**
 * Run `count` accepted user prompts on one owned root thread and launch one
 * child on each, so several children stay queued-or-running at once.
 *
 * Each prompt is claimed and finished by the test, never generated on, so the
 * child dispatch actions enqueued by `attach` stay unexecuted and every child
 * remains active. Prompt `n` publishes the root's turn token
 * `${assignmentId}:n`; a null claim result would mean the token moved, so the
 * counter is a real assertion rather than bookkeeping.
 */
async function fillActiveChildSlots(t: Convex, count: number) {
  const receipt = await open(t, "prompt 1", "r1");
  const { threadId, assignmentId } = receipt;
  const children: Awaited<ReturnType<typeof reserveAndAttachChild>>[] = [];

  for (let index = 0; index < count; index++) {
    if (index > 0) {
      await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
        threadId,
        text: `prompt ${index + 1}`,
        requestKey: `r${index + 1}`,
      });
    }

    const rootTurn = { assignmentId, turnToken: `${assignmentId}:${index}` };

    expect(await t.mutation(components.agevex.turns.slices.claim, rootTurn)).not.toBeNull();
    children.push(await reserveAndAttachChild(t, rootTurn, `call-${index}`));
    await t.mutation(components.agevex.turns.slices.finish, { ...rootTurn, errorCode: null });
  }

  return { ...receipt, children };
}

/**
 * Ask the real reservation what it would decide, then roll the probe back.
 *
 * `reserve` writes on every accepted launch, so the only way to observe a
 * refusal without spending an active slot or a per-prompt launch is to run it
 * in a transaction that throws afterwards. The decision itself is the real one.
 */
async function probeReserve(
  t: Convex,
  rootTurn: { assignmentId: string; turnToken: string },
  toolCallId: string,
) {
  let outcome = "";

  await t
    .run(async (ctx) => {
      const reserved = await ctx.runMutation(components.agevex.subagents.launch.reserve, {
        ...rootTurn,
        toolCallId,
        agent: "Researcher",
        payloadFingerprint: toolCallId,
        coordinateHandle: await createFunctionHandle(coordinateReference()),
      });

      outcome =
        reserved.kind === "reserved"
          ? "reserved"
          : reserved.kind === "denied"
            ? `denied:${reserved.code}`
            : "replayed";

      throw new Error("probe rolled back");
    })
    .catch(() => undefined);

  return outcome;
}

/** Claim a queued child turn and return the linkage a dispatcher would receive. */
async function claimChild(t: Convex, childTurn: { assignmentId: string; turnToken: string }) {
  const claimed = (await t.mutation(components.agevex.turns.slices.claim, childTurn)) as {
    subagent: ClaimedChild | null;
  } | null;

  if (!claimed?.subagent) throw new Error("CLAIM_REFUSED");

  return claimed.subagent;
}

/** Hold every child generation open so a second root turn can run meanwhile. */
function holdChild() {
  state.childGate = new Promise<void>((resolve) => {
    state.childRelease = resolve;
  });
}

it("runs Main -> Researcher -> Main and reports only persisted state", async () => {
  const t = setup();

  state.delegate = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    subagents: { active: 0, history: 1, total: 1 },
  });

  const page = await runs(t, receipt.threadId);

  expect(page.page).toHaveLength(1);

  expect(page.page[0]).toMatchObject({
    agent: "Researcher",
    status: "completed",
    deliveryStatus: "accepted",
    errorCode: null,
  });

  expect(page.page[0].startedAt).not.toBeNull();
  expect(page.page[0].finishedAt).not.toBeNull();
  expect(page.page[0].deliveryAt).not.toBeNull();
  expect(page.page[0].resultMessageId).not.toBeNull();

  // Fixed-size projection of persisted transitions, in order.
  expect(page.page[0].events.map((e) => e.phase)).toEqual([
    "queued",
    "started",
    "completed",
    "result_accepted",
  ]);

  expect(page.page[0].events.every((e) => e.runId === page.page[0].runId)).toBe(true);

  // The parent turn is never blocked by the child, and the parent transcript
  // carries the child's actual output.
  expect((await texts(t, receipt.threadId)).join("\n")).toContain(
    "RESEARCHER deterministic native result",
  );

  expect(state.calls.every((call) => call.maxOutputTokens === 4096)).toBe(true);
  // Phase 1a offers the tool to both the initial turn and its result continuation.
  expect(state.offers.filter((o) => o.tools.includes("agevex_delegate"))).toHaveLength(2);

  expect(
    state.offers
      .filter((o) => o.agent === "Researcher")
      .every(
        (o) =>
          JSON.stringify(o.tools) ===
          JSON.stringify(["agevex_ask_parent", "agevex_message_parent"]),
      ),
  ).toBe(true);
});

// Phase 1a: result continuations spend the same run budget and may delegate.
it("a result turn can delegate again", async () => {
  const t = setup();

  state.delegate = true;
  state.delegationRounds = 2;
  const receipt = await open(t);

  await drain(t);
  const page = (await runs(t, receipt.threadId)).page;

  expect(page).toHaveLength(2);

  expect(page.every((run) => run.status === "completed" && run.deliveryStatus === "accepted")).toBe(
    true,
  );

  expect(state.calls).toHaveLength(3);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("RESEARCHER deterministic native result");
});

it("refuses a launch that exceeds the task bound without starting a run", async () => {
  const t = setup();

  state.delegate = true;
  state.delegateTask = "x".repeat(4001);
  const receipt = await open(t);

  await drain(t);
  expect((await runs(t, receipt.threadId)).page).toHaveLength(0);
  expect((await toolOutputs(t, receipt.threadId)).join("\n")).toContain("TASK_LIMIT");
});

it("refuses a launch to an agent outside the declared graph", async () => {
  const t = setup();

  state.delegate = true;
  state.delegateAgent = "Auditor";
  const receipt = await open(t);

  await drain(t);
  expect((await runs(t, receipt.threadId)).page).toHaveLength(0);
  expect((await toolOutputs(t, receipt.threadId)).join("\n")).toContain("FORBIDDEN");
});

it("refuses a launch the host policy denies and starts nothing", async () => {
  const t = setup();

  state.delegate = true;
  state.denyDelegate = true;
  const receipt = await open(t);

  await drain(t);
  expect((await runs(t, receipt.threadId)).page).toHaveLength(0);

  // A denial is a tool result, so the root turn still succeeded.
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0, history: 0, total: 0 },
  });
});

it("accepts a fourth launch below the concurrent cap", async () => {
  const t = setup();

  // Hold the root generation so its turn keeps owning the token while several
  // coordinator launches are driven with the capabilities the tool would use.
  state.gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });

  const receipt = await open(t);

  await expect
    .poll(async () => {
      await vi.advanceTimersByTimeAsync(100);

      return state.calls.length;
    })
    .toBe(1);

  const { assignmentId } = (await t
    .withIdentity({ subject: "alice" })
    .query(api.agents.activity, { threadId: receipt.threadId })) as {
    assignmentId: string;
  };

  const launch = (toolCallId: string) =>
    t.mutation(coordinateReference(), {
      op: "launch" as const,
      assignmentId,
      turnToken: `${assignmentId}:0`,
      toolCallId,
      agent: "Researcher",
      task: "one bounded task",
    });

  // One accepted user prompt may fan out to three distinct children.
  for (const toolCallId of ["call-1", "call-2", "call-3"]) {
    expect(await launch(toolCallId)).toMatchObject({ status: "queued" });
  }

  // Phase 1a replaces the three-launch per-prompt bound with a run budget.
  expect(await launch("call-4")).toMatchObject({ status: "queued" });
  expect((await runs(t, receipt.threadId)).page).toHaveLength(4);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    subagents: { active: 4, history: 0, total: 4 },
  });

  state.release!();
  state.gate = undefined;
  state.release = undefined;
  await drain(t);
  await drain(t);
  await drain(t);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0, history: 4, total: 4 },
  });
});

it("holds five concurrent child runs per root and refuses the sixth", async () => {
  const t = setup();
  const { assignmentId, threadId, children } = await fillActiveChildSlots(t, 5);

  // Five accepted children, one per distinct user turn token, all still active.
  expect(new Set(children.map((child) => child.runId)).size).toBe(5);
  expect((await runs(t, threadId)).page).toHaveLength(5);

  expect(await activity(t, threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 5, history: 0, total: 5 },
  });

  // The sixth accepted user prompt is refused by the concurrent cap, which is
  // checked before that prompt's own unspent allowance.
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId,
    text: "prompt 6",
    requestKey: "r6",
  });

  const rootTurn = { assignmentId, turnToken: `${assignmentId}:5` };

  expect(await t.mutation(components.agevex.turns.slices.claim, rootTurn)).not.toBeNull();

  expect(
    await t.mutation(coordinateReference(), {
      op: "launch" as const,
      ...rootTurn,
      toolCallId: "call-5",
      agent: "Researcher",
      task: "one bounded task",
    }),
  ).toEqual({ status: "denied", code: "ACTIVE_LIMIT" });

  // The refusal is a tool result: it starts no run and spends no allowance.
  expect((await runs(t, threadId)).page).toHaveLength(5);

  expect(await activity(t, threadId)).toMatchObject({
    subagents: { active: 5, history: 0, total: 5 },
  });

  await t.mutation(components.agevex.turns.slices.finish, { ...rootTurn, errorCode: null });
});

it("replays a duplicated launch at the concurrent cap without taking a slot", async () => {
  const t = setup();
  // Four slots are filled, so the next prompt's child lands exactly at the cap
  // while its root turn is still running.
  const { assignmentId, threadId } = await fillActiveChildSlots(t, 4);

  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId,
    text: "prompt 5",
    requestKey: "r5",
  });

  const rootTurn = { assignmentId, turnToken: `${assignmentId}:4` };

  expect(await t.mutation(components.agevex.turns.slices.claim, rootTurn)).not.toBeNull();
  const coordinate = coordinateReference();

  const launch = {
    op: "launch" as const,
    ...rootTurn,
    toolCallId: "call-4",
    agent: "Researcher",
    task: "one bounded task",
  };

  const accepted = await t.mutation(coordinate, launch);

  expect(accepted).toMatchObject({ status: "queued" });
  expect(await activity(t, threadId)).toMatchObject({ subagents: { active: 5 } });

  // A duplicated callback for the accepted tuple returns the original run at
  // the cap instead of taking a sixth slot, and dedup still precedes it.
  expect(await t.mutation(coordinate, launch)).toEqual(accepted);

  expect(await t.mutation(coordinate, { ...launch, task: "a different task" })).toEqual({
    status: "denied",
    code: "DELEGATION_CONFLICT",
  });

  expect((await runs(t, threadId)).page).toHaveLength(5);
  expect(await activity(t, threadId)).toMatchObject({ subagents: { active: 5 } });

  // The same prompt's second, differently identified launch meets the full cap
  // first, so it is `ACTIVE_LIMIT` here. Its run budget still has eleven
  // launches left, independently of the concurrent cap.
  expect(await t.mutation(coordinate, { ...launch, toolCallId: "call-4-again" })).toEqual({
    status: "denied",
    code: "ACTIVE_LIMIT",
  });

  await t.mutation(components.agevex.turns.slices.finish, { ...rootTurn, errorCode: null });
});

it("frees an active child slot when a run settles", async () => {
  const t = setup();
  const { assignmentId, threadId, children } = await fillActiveChildSlots(t, 5);
  const claimed = await claimChild(t, children[0].childTurn);

  // A terminal settlement through the real capability path: an unverifiable
  // result settles failed, which frees the active slot either way.
  await t.mutation(coordinateReference(), {
    op: "settle",
    ...children[0].childTurn,
    runId: claimed.runId,
    resultMessageId: "not-a-saved-native-message",
    errorCode: null,
  });

  expect(await activity(t, threadId)).toMatchObject({
    subagents: { active: 4, history: 1, total: 5 },
  });

  // The freed slot takes the next accepted user prompt.
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId,
    text: "prompt 6",
    requestKey: "r6",
  });

  const rootTurn = { assignmentId, turnToken: `${assignmentId}:5` };

  expect(await t.mutation(components.agevex.turns.slices.claim, rootTurn)).not.toBeNull();

  expect(
    await t.mutation(coordinateReference(), {
      op: "launch" as const,
      ...rootTurn,
      toolCallId: "call-5",
      agent: "Researcher",
      task: "one bounded task",
    }),
  ).toMatchObject({ status: "queued" });

  expect((await runs(t, threadId)).page).toHaveLength(6);

  expect(await activity(t, threadId)).toMatchObject({
    subagents: { active: 5, history: 1, total: 6 },
  });

  await t.mutation(components.agevex.turns.slices.finish, { ...rootTurn, errorCode: null });
});

it("keeps the root usable while a child is still running", async () => {
  const t = setup();

  state.delegate = true;
  holdChild();
  const receipt = await open(t);

  await expect
    .poll(async () => {
      await vi.advanceTimersByTimeAsync(100);

      return (await activity(t, receipt.threadId)).subagents.active;
    })
    .toBe(1);

  // A second caller prompt is accepted on the same owned thread.
  await expect(
    t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "and also this",
      requestKey: "r2",
    }),
  ).resolves.toMatchObject({ status: "accepted" });

  expect((await runs(t, receipt.threadId)).page).toHaveLength(1);
  releaseChild();
  await drain(t);
  await drain(t);

  // The second caller prompt is a different turn token, so it carries its own
  // allowance and Main delegates once more from it: the per-prompt bound is not
  // a whole-thread bound, and the root was never blocked by its child.
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0, history: 2, total: 2 },
  });

  expect((await runs(t, receipt.threadId)).page.every((run) => run.agent === "Researcher")).toBe(
    true,
  );
});

it("replays a duplicated tool call and conflicts on a changed payload", async () => {
  const t = setup();

  // Hold the root generation so the turn keeps owning its token while the test
  // drives the coordinator directly with the same capabilities the tool uses.
  state.gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });

  const receipt = await open(t);

  await expect
    .poll(async () => {
      await vi.advanceTimersByTimeAsync(100);

      return state.calls.length;
    })
    .toBe(1);

  const { assignmentId } = (await t
    .withIdentity({ subject: "alice" })
    .query(api.agents.activity, { threadId: receipt.threadId })) as {
    assignmentId: string;
  };

  const launch = {
    op: "launch" as const,
    assignmentId,
    turnToken: `${assignmentId}:0`,
    toolCallId: "call-1",
    agent: "Researcher",
    task: "one bounded task",
  };

  const coordinate = coordinateReference();
  const first = await t.mutation(coordinate, launch);

  expect(first).toMatchObject({ status: "queued", agent: "Researcher" });
  // Identical payload under the same tuple replays the original run.
  expect(await t.mutation(coordinate, launch)).toEqual(first);

  // A changed payload under the same tuple is a conflict, not a replay.
  expect(await t.mutation(coordinate, { ...launch, task: "a different task" })).toEqual({
    status: "denied",
    code: "DELEGATION_CONFLICT",
  });

  // Neither replay nor conflict spends an active slot or a per-prompt launch,
  // so the same turn can still fan out to its remaining two.
  expect(await t.mutation(coordinate, { ...launch, toolCallId: "call-2" })).toMatchObject({
    status: "queued",
  });

  expect(await t.mutation(coordinate, { ...launch, toolCallId: "call-3" })).toMatchObject({
    status: "queued",
  });

  expect((await runs(t, receipt.threadId)).page).toHaveLength(3);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    subagents: { active: 3, history: 0, total: 3 },
  });

  state.release!();
  state.gate = undefined;
  state.release = undefined;
  await drain(t);
  await drain(t);
  await drain(t);
  expect((await runs(t, receipt.threadId)).page).toHaveLength(3);
});

it("records a failed child run and still delivers one truthful notification", async () => {
  const t = setup();

  state.delegate = true;
  state.childFail = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);
  const page = await runs(t, receipt.threadId);

  expect(page.page[0]).toMatchObject({
    status: "failed",
    deliveryStatus: "accepted",
    errorCode: "GENERATION_FAILED",
  });

  expect(page.page[0].events.map((e) => e.phase)).toEqual([
    "queued",
    "started",
    "failed",
    "result_accepted",
  ]);

  const joined = (await texts(t, receipt.threadId)).join("\n");

  expect(joined).toContain("Researcher failed the delegated task");
  expect(joined).not.toContain("private child provider error");

  // A failed child never poisons the root.
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
  });
});

it("blocks delivery when the host policy refuses and writes no parent message", async () => {
  const t = setup();

  state.delegate = true;
  state.denyDeliver = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);
  const page = await runs(t, receipt.threadId);

  expect(page.page[0]).toMatchObject({
    status: "completed",
    deliveryStatus: "blocked",
    errorCode: "AUTHORIZATION_DENIED",
  });

  expect(page.page[0].events.map((e) => e.phase)).toEqual([
    "queued",
    "started",
    "completed",
    "delivery_blocked",
  ]);

  expect(page.page[0].resultMessageId).toBeNull();
  expect((await texts(t, receipt.threadId)).join("\n")).not.toContain("RESEARCHER");

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    subagents: { active: 0, history: 1, total: 1 },
  });
});

it("refuses child execution the host revokes, without a second generation", async () => {
  const t = setup();

  state.delegate = true;
  state.revokeChild = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);
  const page = await runs(t, receipt.threadId);

  expect(page.page[0]).toMatchObject({ status: "failed", errorCode: "AUTHORIZATION_DENIED" });
  expect(state.offers.filter((o) => o.agent === "Researcher")).toHaveLength(0);
});

it("escalates a failed Workflow child run once and makes one bounded notification attempt", async () => {
  const t = setup();
  const receipt = await open(t);
  const { childTurn } = await launchChild(t, receipt.assignmentId);

  // Claim the queued child exactly as the Workflow slice would. It moves
  // the run to `running`; the dispatch that
  // is already queued then observes an owned token and no-ops, so no model ever
  // runs and no abort timer is left behind.
  const claimed = (await t.mutation(components.agevex.turns.slices.claim, childTurn)) as {
    subagent: ClaimedChild | null;
  } | null;

  const child = claimed?.subagent;

  expect(child).not.toBeNull();
  const runId = child!.runId;
  const before = (await runs(t, receipt.threadId)).page[0];

  expect(before.runId).toBe(runId);
  expect(before).toMatchObject({ status: "running", deliveryStatus: "pending" });

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 1, history: 0, total: 1 },
  });

  const failure = await failLoop(t, childTurn.assignmentId);

  await t.mutation(finalizeFailure, failure);
  await t.finishInProgressScheduledFunctions();

  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    status: "failed",
    errorCode: "EXECUTION_AMBIGUOUS",
  });

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    subagents: { active: 0, history: 1, total: 1 },
  });

  await drain(t);
  const page = (await runs(t, receipt.threadId)).page[0];

  expect(page).toMatchObject({
    status: "failed",
    deliveryStatus: "accepted",
    errorCode: "EXECUTION_AMBIGUOUS",
  });

  expect(page.events.map((e) => e.phase)).toEqual([
    "queued",
    "started",
    "failed",
    "result_accepted",
  ]);

  const failures = () =>
    texts(t, receipt.threadId).then((all) =>
      all.filter((text) => text.includes("Researcher failed the delegated task")),
    );

  // A healthy root is not poisoned by a failed child step.
  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    subagents: { active: 0, history: 1, total: 1 },
  });

  expect(await failures()).toHaveLength(1);

  // A late success cannot overwrite the terminal outcome, move the counters or
  // produce a second accepted parent notification.
  await expect(
    t.mutation(coordinateReference(), {
      op: "settle",
      ...childTurn,
      runId,
      resultMessageId: "a-message-that-was-never-saved",
      errorCode: null,
    }),
  ).rejects.toThrow("FORBIDDEN");

  await expect(
    t.mutation(coordinateReference(), { op: "notify", runId, deliveryToken: child!.deliveryToken }),
  ).resolves.toBeNull();

  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    status: "failed",
    deliveryStatus: "accepted",
    errorCode: "EXECUTION_AMBIGUOUS",
  });

  expect(await activity(t, receipt.threadId)).toMatchObject({
    subagents: { active: 0, history: 1, total: 1 },
  });

  expect(await failures()).toHaveLength(1);
});

it("never strands an active run when the settlement transaction fails", async () => {
  const t = setup("settle");

  state.delegate = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);
  // The outcome could not be recorded, so the child turn is never released back
  // to idle — that would release the failure ownership needed to record this
  // run. The dispatcher's ambiguity path records the terminal failure and makes
  // the one bounded notification attempt instead.
  const page = (await runs(t, receipt.threadId)).page[0];

  expect(page).toMatchObject({
    status: "failed",
    deliveryStatus: "accepted",
    errorCode: "EXECUTION_AMBIGUOUS",
  });

  expect(page.events.map((e) => e.phase)).toEqual([
    "queued",
    "started",
    "failed",
    "result_accepted",
  ]);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    subagents: { active: 0, history: 1, total: 1 },
  });

  // No provider retry and no second generation of the same child.
  expect(state.offers.filter((offer) => offer.agent === "Researcher")).toHaveLength(1);
});

it("never settles an empty child result as completed", async () => {
  const t = setup();

  state.delegate = true;
  state.childText = "   ";
  const receipt = await open(t);

  await drain(t);
  await drain(t);

  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    status: "failed",
    deliveryStatus: "accepted",
    errorCode: "EMPTY_RESULT",
  });

  expect((await texts(t, receipt.threadId)).join("\n")).toContain(
    "failed the delegated task (EMPTY_RESULT)",
  );
});

it("refuses to settle a result the child transcript does not prove", async () => {
  const t = setup();
  const receipt = await open(t);
  const { childTurn } = await launchChild(t, receipt.assignmentId);

  const claimed = (await t.mutation(components.agevex.turns.slices.claim, childTurn)) as {
    subagent: ClaimedChild | null;
  } | null;

  const runId = claimed!.subagent!.runId;
  const deliveryToken = claimed!.subagent!.deliveryToken;

  // A caller-selected message id is not a saved, successful, non-empty message
  // of the expected child on the expected thread, so it settles as failed.
  await expect(
    t.mutation(coordinateReference(), {
      op: "settle",
      ...childTurn,
      runId,
      resultMessageId: "not-a-saved-native-message",
      errorCode: null,
    }),
  ).resolves.toBeNull();

  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    status: "failed",
    errorCode: "RESULT_UNVERIFIED",
  });

  await drain(t);

  // Nothing scheduled a notification for a settlement this test drove itself, so
  // the run is still honestly undelivered until the capability is presented.
  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    status: "failed",
    deliveryStatus: "pending",
    errorCode: "RESULT_UNVERIFIED",
  });

  await expect(
    t.mutation(coordinateReference(), { op: "notify", runId, deliveryToken }),
  ).resolves.toBeNull();

  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    status: "failed",
    deliveryStatus: "accepted",
    errorCode: "RESULT_UNVERIFIED",
  });

  // Exactly one accepted notification, and a repeated notify is a no-op.
  await expect(
    t.mutation(coordinateReference(), { op: "notify", runId, deliveryToken }),
  ).resolves.toBeNull();

  expect(
    (await texts(t, receipt.threadId)).filter((text) =>
      text.includes("failed the delegated task (RESULT_UNVERIFIED)"),
    ),
  ).toHaveLength(1);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    subagents: { active: 0, history: 1, total: 1 },
  });
});

it("never settles a named user message on the child thread as a result", async () => {
  const t = setup();
  const receipt = await open(t);
  const { childTurn, childThreadId } = await launchChild(t, receipt.assignmentId);
  const claimed = await claimChild(t, childTurn);

  // Native storage lets a caller save a `user` message that names an agent,
  // which is exactly the shape of a parent notification. It is a legitimate
  // native message; it is simply not a child result.
  const messageId = await t.run(async (ctx) => {
    const saved = await saveMessage(ctx, components.agent, {
      threadId: childThreadId,
      prompt: "a user-role message naming the child agent",
      userId: "alice",
      agentName: "Researcher",
    });

    return saved.messageId;
  });

  await expect(
    t.mutation(coordinateReference(), {
      op: "settle",
      ...childTurn,
      runId: claimed.runId,
      resultMessageId: messageId,
      errorCode: null,
    }),
  ).resolves.toBeNull();

  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    status: "failed",
    deliveryStatus: "pending",
    errorCode: "RESULT_UNVERIFIED",
    resultMessageId: null,
  });

  // One bounded attempt, and it can only carry the sanitized failure: the
  // user-role text is never forwarded to the parent as a result.
  await t.mutation(coordinateReference(), {
    op: "notify",
    runId: claimed.runId,
    deliveryToken: claimed.deliveryToken,
  });

  const delivered = await texts(t, receipt.threadId);

  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    status: "failed",
    deliveryStatus: "accepted",
    errorCode: "RESULT_UNVERIFIED",
  });

  expect(delivered.join("\n")).toContain("failed the delegated task (RESULT_UNVERIFIED)");
  expect(delivered.join("\n")).not.toContain("a user-role message naming the child agent");

  // Native user messages themselves are untouched: only result verification
  // requires the assistant role.
  const nativeRoles = await t.run(async (ctx) => {
    const page = await listMessages(ctx, components.agent, {
      threadId: childThreadId,
      paginationOpts: { cursor: null, numItems: 20 },
    });

    return page.page.map((message) => message.message?.role);
  });

  expect(nativeRoles).toContain("user");

  expect(await activity(t, receipt.threadId)).toMatchObject({
    subagents: { active: 0, history: 1, total: 1 },
  });
});

it("delivers a committed child result even when child finalization fails", async () => {
  const t = setup("childFinish");

  state.delegate = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);
  await drain(t);
  // Settlement committed before the delivery attempt, and the child turn's own
  // `turns.slices.finish` is the only fault, so the outcome and counters are exactly
  // the ones an unfaulted run records.
  const page = (await runs(t, receipt.threadId)).page[0];

  expect(page).toMatchObject({
    status: "completed",
    deliveryStatus: "accepted",
    errorCode: null,
    resultMessageId: expect.any(String),
  });

  expect(page.events.map((e) => e.phase)).toEqual([
    "queued",
    "started",
    "completed",
    "result_accepted",
  ]);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    errorCode: null,
    subagents: { active: 0, history: 1, total: 1 },
  });

  const delivered = await texts(t, receipt.threadId);

  expect(
    delivered.filter((text) => text.includes("Researcher completed the delegated task")),
  ).toHaveLength(1);

  expect(delivered.join("\n")).toContain("RESEARCHER deterministic native result");
  // The delivered result still woke the parent for one follow-up turn, and the
  // generation was never replayed: one child generation, and no child retry.
  expect(state.offers.filter((offer) => offer.tools.includes("agevex_delegate"))).toHaveLength(2);
  expect(state.offers.filter((offer) => offer.agent === "Researcher")).toHaveLength(1);
  // The fault is never claimed twice: the escalated child run stays terminal
  // with one accepted notification; no later activity may re-deliver it.
  await vi.advanceTimersByTimeAsync(301_000);
  await drain(t);

  expect((await runs(t, receipt.threadId)).page[0].events.map((e) => e.phase)).toEqual([
    "queued",
    "started",
    "completed",
    "result_accepted",
  ]);

  expect(
    (await texts(t, receipt.threadId)).filter((text) =>
      text.includes("Researcher completed the delegated task"),
    ),
  ).toHaveLength(1);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    subagents: { active: 0, history: 1, total: 1 },
  });
});

it("records a failed delivery when the queue acceptance of the result fails", async () => {
  const t = setup("acceptedDelivery");

  state.delegate = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);
  // The native parent save and the queue acceptance share one transaction, so
  // refusing only the accepted record rolls the parent message back with it,
  // while the separate metadata-only failure record commits.
  const page = (await runs(t, receipt.threadId)).page[0];

  expect(page).toMatchObject({
    status: "completed",
    deliveryStatus: "failed",
    errorCode: "DELIVERY_FAILED",
    resultMessageId: null,
  });

  expect(page.events.map((e) => e.phase)).toEqual([
    "queued",
    "started",
    "completed",
    "delivery_failed",
  ]);

  // The rolled-back parent message left no text and no backlog row behind, and
  // the truthful child outcome and its counters are untouched.
  expect((await texts(t, receipt.threadId)).join("\n")).not.toContain("RESEARCHER");

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    errorCode: null,
    subagents: { active: 0, history: 1, total: 1 },
  });
});

it("run budget denies the 13th launch", async () => {
  const t = setup();
  const receipt = await open(t);
  // Claim the root turn exactly as the Workflow slice would and never hand it
  // back, so the actor is still RUNNING while its child runs and settles. The
  // already-queued dispatch then observes the owned token and no-ops.
  const rootTurn = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:0` };

  await t.mutation(components.agevex.turns.slices.claim, rootTurn);
  const coordinate = coordinateReference();

  const launch = {
    op: "launch" as const,
    ...rootTurn,
    toolCallId: "call-1",
    agent: "Researcher",
    task: "one bounded task",
  };

  const first = await t.mutation(coordinate, launch);

  expect(first).toMatchObject({ status: "queued", agent: "Researcher" });
  const runId = (first as { runId: string }).runId;

  // The child reaches its terminal state and the active cap is free again,
  // while the root actor still owns its running turn token.
  await drain(t);

  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    runId,
    status: "completed",
    deliveryStatus: "accepted",
  });

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "running",
    subagents: { active: 0, history: 1, total: 1 },
  });

  // A terminal child frees an active slot, so the same accepted user prompt
  // still cannot spend more than its own allowance, whatever the child state.
  for (const toolCallId of Array.from(
    { length: LIMITS.runLaunches - 1 },
    (_, i) => `call-${i + 2}`,
  )) {
    expect(await t.mutation(coordinate, { ...launch, toolCallId })).toMatchObject({
      status: "queued",
    });

    await drain(t);
  }

  expect(await t.mutation(coordinate, { ...launch, toolCallId: "call-13" })).toEqual({
    status: "denied",
    code: "RUN_BUDGET",
  });

  expect((await runs(t, receipt.threadId)).page).toHaveLength(12);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "running",
    subagents: { active: 0, history: 12, total: 12 },
  });

  // Each accepted child was generated exactly once: a settled child never
  // replenished its parent's prompt budget, so no extra child thread exists.
  expect(state.offers.filter((offer) => offer.agent === "Researcher")).toHaveLength(12);
  // Dedup still precedes the allowance: the exact tuples replay their original
  // runs, and a changed payload under one of them is still a conflict.
  expect(await t.mutation(coordinate, launch)).toEqual(first);

  expect(await t.mutation(coordinate, { ...launch, task: "a different task" })).toEqual({
    status: "denied",
    code: "DELEGATION_CONFLICT",
  });

  expect((await runs(t, receipt.threadId)).page).toHaveLength(12);

  // The refusal is a tool result, so the root turn still finalizes normally.
  await t.mutation(components.agevex.turns.slices.finish, { ...rootTurn, errorCode: null });
  await drain(t);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    subagents: { active: 0, history: 12, total: 12 },
  });
});

it("gives each accepted user prompt a fresh run budget through native delivery", async () => {
  const t = setup();

  state.delegate = true;
  const receipt = await open(t, "first", "r1");

  await drain(t);
  await drain(t);
  await drain(t);
  expect((await runs(t, receipt.threadId)).page).toHaveLength(1);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0, history: 1, total: 1 },
  });

  // Phase 1a: both the user turn and its result continuation receive the tool;
  // only the next user prompt starts a fresh run budget.
  expect(state.offers.filter((o) => o.tools.includes("agevex_delegate"))).toHaveLength(2);

  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "second",
    requestKey: "r2",
  });

  await drain(t);
  await drain(t);
  await drain(t);
  expect((await runs(t, receipt.threadId)).page).toHaveLength(2);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0, history: 2, total: 2 },
  });

  // Both caller prompts and both result continuations received the managed tool.
  expect(state.offers.filter((o) => o.tools.includes("agevex_delegate"))).toHaveLength(4);
});

it("rolls the whole launch back when attaching the child fails", async () => {
  const t = setup("attach");
  const receipt = await open(t);
  // Claim the root turn and keep it, so the aborted launch is driven with the
  // capability the managed tool would present while the actor still owns its
  // running token.
  const rootTurn = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:0` };

  await t.mutation(components.agevex.turns.slices.claim, rootTurn);

  await expect(
    t.mutation(coordinateReference(), {
      op: "launch" as const,
      ...rootTurn,
      toolCallId: "call-1",
      agent: "Researcher",
      task: "one bounded task",
    }),
  ).rejects.toThrow("injected failure");

  // No run, no counter movement and no child thread survive the aborted launch.
  expect((await runs(t, receipt.threadId)).page).toHaveLength(0);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    subagents: { active: 0, history: 0, total: 0 },
  });

  // The per-prompt allowance rolled back with the reservation, so the same
  // actor turn can still reserve its whole allowance. Each probe transaction
  // rolls itself back, so it proves the allowance without leaving a run behind.
  for (const toolCallId of ["call-2", "call-3", "call-4"]) {
    expect(await probeReserve(t, rootTurn, toolCallId)).toBe("reserved");
  }

  expect((await runs(t, receipt.threadId)).page).toHaveLength(0);
  await t.mutation(components.agevex.turns.slices.finish, { ...rootTurn, errorCode: null });
});

it("records a failed delivery when the notification transaction does not commit", async () => {
  const t = setup("notificationSave");

  state.delegate = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);
  // The delivered parent notification is itself saved as a named user message,
  // so this fault refuses the one native save that produces it: the attempt
  // cannot commit its parent message at all. The truthful child outcome and its
  // counters still survive, and the separate, metadata-only failure record can.
  // The companion `acceptedDelivery` fault covers the other boundary, where the
  // parent message is saved first and the queue acceptance is what fails.
  const page = (await runs(t, receipt.threadId)).page[0];

  expect(page).toMatchObject({
    status: "completed",
    deliveryStatus: "failed",
    errorCode: "DELIVERY_FAILED",
    resultMessageId: null,
  });

  expect(page.events.map((e) => e.phase)).toEqual([
    "queued",
    "started",
    "completed",
    "delivery_failed",
  ]);

  // No parent message and no backlog row survive the rolled-back attempt.
  expect((await texts(t, receipt.threadId)).join("\n")).not.toContain("RESEARCHER");

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    errorCode: null,
    subagents: { active: 0, history: 1, total: 1 },
  });
});

it("leaves the run honestly pending when the delivery record itself fails", async () => {
  const t = setup("deliver");

  state.delegate = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);

  // The attempt and its failure record are the same mutation here, so neither
  // could commit and nothing is claimed about a delivery that did not happen.
  expect((await runs(t, receipt.threadId)).page[0]).toMatchObject({
    status: "completed",
    deliveryStatus: "pending",
    resultMessageId: null,
  });

  expect((await texts(t, receipt.threadId)).join("\n")).not.toContain("RESEARCHER");

  expect(await activity(t, receipt.threadId)).toMatchObject({
    subagents: { active: 0, history: 1, total: 1 },
  });
});

it("pages run history newest first within the bounded page size", async () => {
  const t = setup();

  state.delegate = true;
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await open(t);

  await drain(t);
  await drain(t);

  for (let i = 0; i < 2; i++) {
    await alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: `again ${i}`,
      requestKey: `again${i}`,
    });

    await drain(t);
    await drain(t);
    await drain(t);
  }

  const all = await runs(t, receipt.threadId, 20);

  expect(all.page).toHaveLength(3);
  expect(all.isDone).toBe(true);
  const times = all.page.map((r) => r.createdAt);

  expect([...times].sort((a, b) => b - a)).toEqual(times);
  const first = await runs(t, receipt.threadId, 2);

  expect(first.page).toHaveLength(2);
  expect(first.isDone).toBe(false);
  expect(first.page[0].runId).toBe(all.page[0].runId);
  const second = await runs(t, receipt.threadId, 2, first.continueCursor);

  expect(second.page.map((r) => r.runId)).toEqual([all.page[2].runId]);
  expect(second.isDone).toBe(true);
  // The page size is clamped, never honoured upward.
  expect((await runs(t, receipt.threadId, 1000)).page).toHaveLength(3);
  await expect(runs(t, receipt.threadId, 1, "not-a-cursor")).rejects.toThrow("INVALID_CURSOR");
});

it("never exposes a capability or transcript text in the coordination read", async () => {
  const t = setup();

  state.delegate = true;
  const receipt = await open(t);

  await drain(t);
  await drain(t);
  const raw = JSON.stringify(await runs(t, receipt.threadId));

  expect(raw).not.toContain("deliveryToken");
  expect(raw).not.toContain("childAssignmentId");
  expect(raw).not.toContain("RESEARCHER");
});

it("denies a forged or stale capability before any policy call or write", async () => {
  const t = setup();
  const coordinate = coordinateReference();

  await expect(
    t.mutation(coordinate, {
      op: "launch",
      assignmentId: "0000000000000000000000000000",
      turnToken: "forged:0",
      toolCallId: "c1",
      agent: "Researcher",
      task: "do something",
    }),
  ).rejects.toThrow();

  await expect(
    t.mutation(coordinate, { op: "notify", runId: "forged", deliveryToken: "forged" }),
  ).resolves.toBeNull();

  await expect(
    t.mutation(coordinate, {
      op: "settle",
      assignmentId: "nope",
      turnToken: "nope:0",
      runId: "nope",
      errorCode: null,
    }),
  ).rejects.toThrow();

  // An unknown thread authorizes nothing at all.
  await expect(
    t.withIdentity({ subject: "alice" }).query(api.agents.activity, { threadId: "nope" }),
  ).rejects.toThrow();
});

it("launches three children from one model step when Main is asked for three", async () => {
  const t = setup();

  state.delegate = true;
  state.delegateFanout = 3;
  const receipt = await open(t, "run three tasks in parallel", "r1");

  await drain(t);
  await drain(t);
  await drain(t);
  await drain(t);
  // Three explicit tasks became three accepted child runs, all completed and
  // delivered, with no denial anywhere in the root transcript.
  expect((await runs(t, receipt.threadId)).page).toHaveLength(3);

  expect(await activity(t, receipt.threadId)).toMatchObject({
    turnStatus: "idle",
    subagents: { active: 0, history: 3, total: 3 },
  });

  expect(
    (await runs(t, receipt.threadId)).page.every(
      (run) => run.status === "completed" && run.deliveryStatus === "accepted",
    ),
  ).toBe(true);

  expect((await toolOutputs(t, receipt.threadId)).join("\n")).not.toContain("TASK_LIMIT");

  // All three calls belong to the initial Main step. Their batched result
  // continuation also receives the tool without launching another child.
  expect(
    state.offers.filter((o) => o.agent === "Main" && o.tools.includes("agevex_delegate")),
  ).toHaveLength(2);

  expect(state.calls).toHaveLength(state.offers.filter((o) => o.agent === "Main").length);
  expect(state.offers.filter((o) => o.agent === "Researcher")).toHaveLength(3);
});

it("spends no launch allowance on a stale, out-of-graph or policy-denied attempt", async () => {
  const t = setup();
  const receipt = await open(t, "prompt 1", "r1");

  const rootTurn = {
    assignmentId: receipt.assignmentId,
    turnToken: `${receipt.assignmentId}:0`,
  };

  expect(await t.mutation(components.agevex.turns.slices.claim, rootTurn)).not.toBeNull();
  const coordinate = coordinateReference();

  const launch = (toolCallId: string, agent = "Researcher", turnToken = rootTurn.turnToken) =>
    t.mutation(coordinate, {
      op: "launch" as const,
      assignmentId: rootTurn.assignmentId,
      turnToken,
      toolCallId,
      agent,
      task: "one bounded task",
    });

  // A token this turn does not own is refused before any policy call or write.
  expect(await launch("stale", "Researcher", `${receipt.assignmentId}:9`)).toEqual({
    status: "denied",
    code: "STALE_TURN",
  });

  // An agent outside the declared graph never reaches the reservation.
  expect(await launch("outside", "Auditor")).toEqual({
    status: "denied",
    code: "FORBIDDEN",
  });

  // A host policy denial is a tool result, not a thrown launch.
  state.denyDelegate = true;
  expect(await launch("policy")).toEqual({ status: "denied", code: "FORBIDDEN" });
  state.denyDelegate = false;

  // None of the three refusals spent a launch, so this prompt still has its
  // full run budget of twelve.
  for (const n of [1, 2, 3]) expect(await launch(`call-${n}`)).toMatchObject({ status: "queued" });

  // Phase 1a: expected refusals leave the run budget unspent.
  expect(await launch("call-4")).toMatchObject({ status: "queued" });
  expect((await runs(t, receipt.threadId)).page).toHaveLength(4);
  await t.mutation(components.agevex.turns.slices.finish, { ...rootTurn, errorCode: null });
});

it("never settles or delivers one root's run with another root's capability", async () => {
  const t = setup();
  const rootA = await open(t, "root a", "ra");
  const rootB = await open(t, "root b", "rb");
  const childA = await launchChild(t, rootA.assignmentId);
  const childB = await launchChild(t, rootB.assignmentId);
  const linkA = await claimChild(t, childA.childTurn);
  const linkB = await claimChild(t, childB.childTurn);
  const coordinate = coordinateReference();

  // Each root owns its own child capability: neither token settles the other
  // root's run, in either direction.
  await expect(
    t.mutation(coordinate, {
      op: "settle",
      ...childA.childTurn,
      runId: childB.runId,
      errorCode: null,
    }),
  ).rejects.toThrow();

  await expect(
    t.mutation(coordinate, {
      op: "settle",
      ...childB.childTurn,
      runId: childA.runId,
      errorCode: null,
    }),
  ).rejects.toThrow();

  // Nor does one root's one-shot delivery capability deliver another root's run.
  await expect(
    t.mutation(coordinate, {
      op: "notify",
      runId: childA.runId,
      deliveryToken: linkB.deliveryToken,
    }),
  ).resolves.toBeNull();

  await expect(
    t.mutation(coordinate, {
      op: "notify",
      runId: childB.runId,
      deliveryToken: linkA.deliveryToken,
    }),
  ).resolves.toBeNull();

  // Nothing moved: both runs are still running, still pending delivery, and no
  // result or notification reached either parent transcript.
  for (const [receipt, child] of [
    [rootA, childA],
    [rootB, childB],
  ] as const) {
    const page = await runs(t, receipt.threadId);

    expect(page.page[0]).toMatchObject({
      runId: child.runId,
      status: "running",
      deliveryStatus: "pending",
      errorCode: null,
    });

    expect((await texts(t, receipt.threadId)).join("\n")).not.toContain("RESEARCHER");

    expect(await activity(t, receipt.threadId)).toMatchObject({
      subagents: { active: 1, history: 0, total: 1 },
    });
  }

  // Each root still owns exactly the run it launched.
  expect(linkA.runId).toBe(childA.runId);
  expect(linkB.runId).toBe(childB.runId);
});
