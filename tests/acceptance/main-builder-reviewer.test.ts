// @vitest-environment edge-runtime
/** End-to-end proof: ids cross agent boundaries; bodies stay in the app store. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { call, delegate, text, v2, v2api as api } from "../delegation-v2.host.js";
import { gate } from "../message-parent.fixture.js";
import { requireReceipt } from "../receipt.js";
import { setup, evidence, node } from "./work.fixture.js";
import type { MessageDoc } from "@convex-dev/agent";

type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });
const calls = (name: string) => v2.calls.filter((entry) => entry.agent === name);
const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);

const open = async (t: Test) =>
  requireReceipt(
    await owner(t).mutation(api.agents.open, {
      agent: "Main",
      prompt: "Create work, review it, then report its id",
      requestKey: "acceptance",
    }),
  );

async function waitFor(t: Test, check: () => boolean | Promise<boolean>) {
  await expect
    .poll(
      async () => {
        await t.action(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });

        return check();
      },
      { timeout: 5000 },
    )
    .toBe(true);
}
async function transcript(t: Test, threadId: string) {
  return owner(t).query(api.agents.messages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });
}

// Paginated delegation history supplies the persisted child thread ids.
async function history(t: Test, threadId: string) {
  return (
    await owner(t).query(api.agents.delegations, {
      threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    })
  ).page;
}
function resultId(args: Parameters<NonNullable<typeof v2.steps.Main>>[1], marker: string) {
  const outputs = args.prompt
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .filter((part) => part.type === "tool-result" && part.toolName === marker);

  const part = outputs[outputs.length - 1];
  const output = part?.type === "tool-result" ? part.output : undefined;
  const value = output?.type === "json" ? output.value : undefined;

  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string")
    throw new Error(`Missing ${marker} id`);

  return value.id;
}

/** Models choose the app workflow; agevex supplies delegation, notes and fences. */
function script(held: ReturnType<typeof gate>, forbiddenAsk = false) {
  let originalId = "";
  let fixedId = "";

  v2.steps.Main = (n, args) => {
    if (n === 0) return [delegate("Builder")];

    const match = JSON.stringify(args.prompt).match(/fixed-work:([a-zA-Z0-9]+)/);

    return text(`Ready: ${match?.[1] ?? "missing-id"}`);
  };

  v2.steps.Builder = (n, args) => {
    if (n === 0) return [call("store_work", { body: "original body" })];

    if (n === 1) {
      originalId = resultId(args, "store_work");

      return [delegate("Reviewer", { task: `Review work id ${originalId}` })];
    }

    if (!JSON.stringify(args.prompt).includes("review complete"))
      return text("waiting for reviewer");

    if (!fixedId && JSON.stringify(args.prompt).includes("fixed body")) {
      fixedId = resultId(args, "store_work");

      return text(`fixed-work:${fixedId}`);
    }

    return [call("store_work", { body: "fixed body" })];
  };

  v2.steps.Reviewer = async (n) => {
    if (n === 0) return [call("fetch_work", { id: originalId })];

    if (n === 1) return [call("agevex_message_parent", { text: "review note: fix wording" })];

    if (forbiddenAsk && n === 2) return [call("ask_user", { question: "May I bypass Builder?" })];

    await held.promise;

    return text("review complete: fix wording");
  };

  return { original: () => originalId, fixed: () => fixedId };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("Main → Builder → Reviewer delivers one note before the result, fences Builder and records attributed native usage", async () => {
  const t = setup();
  const held = gate();
  const ids = script(held);
  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 3 && calls("Builder").length === 3);
  const runs = await history(t, receipt.threadId);
  const build = runs.find((run) => run.agent === "Builder")!;
  const review = runs.find((run) => run.agent === "Reviewer")!;

  await waitFor(t, async () => {
    const tree = await owner(t).query(api.agents.runTree, { threadId: receipt.threadId });

    return tree?.nodes.filter((node) => node.status === "asleep").length === 2;
  });

  const active = (await owner(t).query(api.agents.runTree, { threadId: receipt.threadId }))!;

  expect(active.nodes).toHaveLength(3);

  expect(active.nodes).toEqual([
    expect.objectContaining({
      id: active.rootRunId,
      parentId: null,
      agent: "Main",
      status: "asleep",
      reason: "children",
    }),
    expect.objectContaining({
      id: build.runId,
      parentId: active.rootRunId,
      agent: "Builder",
      status: "asleep",
      reason: "children",
    }),
    expect.objectContaining({
      id: review.runId,
      parentId: build.runId,
      agent: "Reviewer",
      status: "running",
    }),
  ]);

  expect(build.status).toBe("running");
  expect(review.status).toBe("running");
  expect(calls("Main")).toHaveLength(1);

  expect((await t.query(node, { threadId: build.childThreadId! }))!.childRunId).toBe(build.runId);

  expect((await t.run((ctx) => ctx.db.query("work").take(3))).map((row) => row.body)).toEqual([
    "original body",
  ]);

  expect(JSON.stringify(calls("Reviewer")[0].args.prompt)).toContain(ids.original());
  expect(JSON.stringify(calls("Reviewer")[0].args.prompt)).not.toContain("original body");
  expect(JSON.stringify(calls("Reviewer")[1].args.prompt)).toContain("original body");
  expect(JSON.stringify(calls("Builder")[2].args.prompt)).toContain("review note");
  held.release();
  await drain(t);

  const delivered = (await transcript(t, build.childThreadId!)).page.filter(
    (m) => m.origin === "note" || m.origin === "result",
  );

  expect(delivered.map((m) => m.origin)).toEqual(["note", "result"]);

  expect(delivered[0]).toMatchObject({
    from: "Reviewer",
    text: expect.stringContaining("review note"),
  });

  expect(delivered[1].text).toContain("review complete");
  expect(delivered[0].order).toBeLessThan(delivered[1].order);

  expect(
    (await transcript(t, receipt.threadId)).page.some(
      (m) => m.role === "assistant" && m.text.includes(ids.fixed()),
    ),
  ).toBe(true);

  expect(ids.fixed()).not.toBe("");
  const rootTranscript = await transcript(t, receipt.threadId);

  expect(
    rootTranscript.page
      .filter((m) => m.origin === "note" || m.origin === "result")
      .map((m) => m.text),
  ).toEqual([expect.stringContaining(`fixed-work:${ids.fixed()}`)]);

  expect(calls("Main")).toHaveLength(2);

  expect((await t.run((ctx) => ctx.db.query("work").take(3))).map((row) => row.body)).toEqual([
    "original body",
    "fixed body",
  ]);

  for (const [agent, nodeId] of [
    ["Main", undefined],
    ["Builder", build.runId],
    ["Reviewer", review.runId],
  ] as const) {
    const usage = evidence.filter((entry) => entry.facts.agent === agent);

    expect(usage.length).toBeGreaterThan(0);

    expect(usage.every((entry) => entry.facts.nodeId === nodeId && entry.usage !== undefined)).toBe(
      true,
    );
  }

  expect(new Set(evidence.map((entry) => entry.key)).size).toBe(evidence.length);
  expect(evidence).toHaveLength(v2.calls.length);
  const done = (await owner(t).query(api.agents.runTree, { threadId: receipt.threadId }))!;

  expect(done.rootRunId).toBe(active.rootRunId);

  expect(done.nodes.map(({ id, parentId, agent }) => ({ id, parentId, agent }))).toEqual(
    active.nodes.map(({ id, parentId, agent }) => ({ id, parentId, agent })),
  );

  expect(done.nodes.every((node) => node.status === "done" && node.currentTool === null)).toBe(
    true,
  );

  expect(done.usage).toBeNull();
  expect(done.nodes.every((node) => node.usage === null)).toBe(true);

  for (const agent of ["Main", "Builder", "Reviewer"]) {
    const own = evidence.filter((entry) => entry.facts.agent === agent);
    const tokens = own.map((entry) => entry.usage as NonNullable<MessageDoc["usage"]>);

    expect(own).toHaveLength(calls(agent).length);

    expect(tokens.every((value) => value.promptTokens! > 0 && value.completionTokens! > 0)).toBe(
      true,
    );
  }
});

it("the default root-only policy denies a child ask_user without creating a human pause", async () => {
  const t = setup();
  const held = gate();

  script(held, true);
  const receipt = await open(t);

  await waitFor(t, async () => {
    const review = (await history(t, receipt.threadId)).find((run) => run.agent === "Reviewer");

    if (!review?.childThreadId) return false;

    return (
      calls("Reviewer").length >= 4 ||
      (await t.query(node, { threadId: review.childThreadId }))?.approvalBlocked === true
    );
  });

  const runs = await history(t, receipt.threadId);
  const review = runs.find((run) => run.agent === "Reviewer")!;
  const row = (await t.query(node, { threadId: review.childThreadId! }))!;

  expect(row.approvalBlocked).not.toBe(true);
  expect(JSON.stringify(calls("Reviewer")[3].args.prompt)).toContain("ROOT_ONLY");

  expect(await owner(t).query(api.agents.pendingApprovals, { threadId: receipt.threadId })).toEqual(
    [],
  );

  held.release();
  await drain(t);
});

it("a running agent with a delegation edge cannot forge another run's recorded parent", async () => {
  const t = setup();
  const held = gate();
  const mainHeld = gate();

  script(held);

  v2.steps.Main = async (n) => {
    if (n === 0) return [delegate("Builder")];

    await mainHeld.promise;

    return text("Main continues");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 3 && calls("Builder").length === 3);
  const review = (await history(t, receipt.threadId)).find((run) => run.agent === "Reviewer")!;

  // A real user request gives Main a live turn. Main has a Reviewer edge and
  // shares this root/epoch, but Builder owns the existing Reviewer delegation.
  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "Continue while Builder reviews",
    requestKey: "continue-main",
  });

  await waitFor(t, () => calls("Main").length === 2);
  const main = (await t.query(node, { threadId: receipt.threadId }))!;

  expect(main.turnStatus).toBe("running");

  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: main._id,
      turnToken: main.turnToken!,
      runId: review.runId,
      text: "forged parent message",
    }),
  ).toEqual({ status: "denied", code: "FORBIDDEN" });

  expect(JSON.stringify(await transcript(t, review.childThreadId!))).not.toContain(
    "forged parent message",
  );

  expect(JSON.stringify(await transcript(t, receipt.threadId))).not.toContain("review note");
  mainHeld.release();
  held.release();
  await drain(t);
});

it("cancel mid-review fences all three agents and discards late review output", async () => {
  const t = setup();
  const held = gate();

  script(held);
  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 3 && calls("Builder").length === 3);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
  const runs = await history(t, receipt.threadId);

  expect(runs).toHaveLength(2);
  expect(runs.every((run) => run.status === "failed")).toBe(true);

  const cancelled = (await owner(t).query(api.agents.runTree, { threadId: receipt.threadId }))!;

  expect(cancelled.nodes).toHaveLength(3);
  expect(cancelled.nodes.map((node) => node.agent)).toEqual(["Main", "Builder", "Reviewer"]);

  for (const node of cancelled.nodes)
    expect(node).toMatchObject({ status: "failed", reason: "cancelled", currentTool: null });

  for (const threadId of [receipt.threadId, ...runs.map((run) => run.childThreadId!)]) {
    const row = (await t.query(node, { threadId }))!;

    expect(row.turnStatus).not.toBe("running");
    expect(row.turnToken).toBeUndefined();
    expect(row.cancelled).toBe(true);
  }

  expect(await t.run((ctx) => ctx.db.query("work").take(3))).toHaveLength(1);
  expect(calls("Main")).toHaveLength(1);
  const review = runs.find((run) => run.agent === "Reviewer")!;

  expect(JSON.stringify(await transcript(t, review.childThreadId!))).not.toContain(
    "review complete",
  );
});
