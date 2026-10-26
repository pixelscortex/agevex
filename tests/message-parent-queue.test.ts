// @vitest-environment edge-runtime
/** Fake-model regressions: message pressure never discards an owed final result. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { v2, delegate, text } from "./delegation-v2.host.js";
import {
  setup,
  open,
  owner,
  calls,
  drain,
  tree,
  transcript,
  waitFor,
  gate,
  sender,
  api,
  components,
  rawAssignment,
} from "./message-parent.fixture.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const message = (t: ReturnType<typeof setup>, threadId: string, key: string) =>
  owner(t).mutation(api.agents.send, { threadId, text: key, requestKey: key });

async function parent(t: ReturnType<typeof setup>, assignmentId: string) {
  const row = (await t.query(rawAssignment, { assignmentId }))!;

  return { assignmentId: row._id, turnToken: row.turnToken! };
}

async function results(
  t: ReturnType<typeof setup>,
  threadId: string,
  count: number,
  total = count,
) {
  await waitFor(
    t,
    async () =>
      (await transcript(t, threadId)).page.filter((row) => row.origin === "result").length ===
      count,
  );

  const page = await owner(t).query(api.agents.delegations, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

  expect(page.page).toHaveLength(total);
  expect(page.page.filter((run) => run.deliveryStatus === "accepted")).toHaveLength(count);
}

it("user sends can fill the message queue before a launch and its final result still delivers", async () => {
  const t = setup({ queueLength: 2 });
  const held = gate();
  const childHeld = gate();

  v2.steps.Main = async (n) => {
    if (!n) await held.promise;

    return text("read the result");
  };

  v2.steps.Reviewer = async () => {
    await childHeld.promise;

    return text("result launched into a full queue");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Main").length === 1);

  for (const key of ["queued one", "queued two"]) await message(t, receipt.threadId, key);

  expect(await message(t, receipt.threadId, "queue full")).toMatchObject({
    status: "rejected",
    code: "QUEUE_FULL",
  });

  expect(
    await t.mutation(api.agents.coordinate, {
      op: "launch",
      ...(await parent(t, receipt.assignmentId)),
      toolCallId: "full-queue-launch",
      agent: "Reviewer",
      task: "finish despite message backlog",
    }),
  ).toMatchObject({ status: "queued" });

  await waitFor(t, () => calls("Reviewer").length === 1);
  childHeld.release();
  await results(t, receipt.threadId, 1);

  expect(
    (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.queuedMessages,
  ).toBe(3);

  expect(await message(t, receipt.threadId, "still full")).toMatchObject({ code: "QUEUE_FULL" });
  held.release();
  await drain(t);

  expect(JSON.stringify(calls("Main")[calls("Main").length - 1]?.args.prompt)).toContain(
    "result launched into a full queue",
  );
});

it("an ask answered mid-turn before its question is consumed cannot crowd out either final result", async () => {
  const t = setup({ queueLength: 2 });
  const held = gate();
  const children = [gate(), gate()];

  v2.steps.Main = async (n) => {
    if (!n) return children.map(() => delegate("Reviewer"));

    await held.promise;

    return text("read both results");
  };

  v2.steps.Reviewer = async (n) => {
    await children[n === 1 ? 1 : 0].promise;

    return text(`mid-turn result ${n === 1 ? 1 : 0}`);
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 2);
  const asking = await sender(t, receipt.threadId);
  const runId = (await tree(t, receipt.threadId))[0].runId;

  await message(t, receipt.threadId, "wake parent");
  await waitFor(t, () => calls("Main").length === 2);
  await message(t, receipt.threadId, "one queued user message");

  expect(
    await t.mutation(api.agents.coordinate, {
      op: "ask",
      ...asking,
      question: "answer before consuming me",
    }),
  ).toMatchObject({ status: "accepted" });

  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      ...(await parent(t, receipt.assignmentId)),
      runId,
      text: "the mid-turn answer",
    }),
  ).toMatchObject({ status: "accepted" });

  children[1].release();
  await results(t, receipt.threadId, 1, 2);
  children[0].release();
  await results(t, receipt.threadId, 2);

  expect(
    (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.queuedMessages,
  ).toBe(4);

  held.release();
  await drain(t);
  const prompt = JSON.stringify(calls("Main")[calls("Main").length - 1]?.args.prompt);

  for (const n of [0, 1]) expect(prompt).toContain(`mid-turn result ${n}`);
});

it.each(["running", "asking"] as const)(
  "a sibling cannot message or answer a %s run and only its recorded parent can interact",
  async (status) => {
    const t = setup();
    const held = gate();
    const parentHeld = gate();

    v2.steps.Main = async (n) => {
      if (!n) return [delegate("Reviewer"), delegate("Builder")];

      await parentHeld.promise;

      return text("read children");
    };

    v2.steps.Reviewer = async () => {
      await held.promise;

      return text("authorized result");
    };

    // Builder has delegation edges, so the host's graph guard would accept
    // this sibling without the component's recorded-parent authorization.
    v2.steps.Builder = v2.steps.Reviewer;

    const receipt = await open(t);

    await waitFor(t, () => calls("Reviewer").length === 1 && calls("Builder").length === 1);
    const child = await sender(t, receipt.threadId);
    const sibling = await sender(t, receipt.threadId, 1);
    const runId = (await tree(t, receipt.threadId))[0].runId;

    await message(t, receipt.threadId, "wake parent");
    await waitFor(t, () => calls("Main").length === 2);

    if (status === "asking")
      expect(
        await t.mutation(api.agents.coordinate, {
          op: "ask",
          ...child,
          question: "parent only",
        }),
      ).toMatchObject({ status: "accepted" });

    expect(
      await t.mutation(api.agents.coordinate, {
        op: "message",
        ...sibling,
        runId,
        text: "unauthorized sibling",
      }),
    ).toMatchObject({ status: "denied", code: "FORBIDDEN" });

    await expect(
      t.mutation(components.agevex.subagents.messages.messageChild, {
        ...sibling,
        runId,
        messageId: "forged-sibling-message",
      }),
    ).rejects.toThrow("FORBIDDEN");

    expect(JSON.stringify(await transcript(t, receipt.threadId))).not.toContain(
      "unauthorized sibling",
    );

    expect(
      await t.mutation(api.agents.coordinate, {
        op: "message",
        ...(await parent(t, receipt.assignmentId)),
        runId,
        text: "authorized parent",
      }),
    ).toMatchObject({ status: "accepted" });

    held.release();
    parentHeld.release();
    await drain(t);
  },
);

it.each(["each"] as const)(
  "wait=%s fresh requests receive RESULTS_PENDING for earlier child results until capacity frees",
  async (wait) => {
    const t = setup({ queueLength: 2, runLaunches: 2 });
    const held = gate();
    const children = [gate(), gate()];

    v2.steps.Main = async (n) => {
      if (!n) return children.map(() => delegate("Reviewer", { wait }));

      if (n === 1) return [delegate("Reviewer")];

      await held.promise;

      return text("read every budget");
    };

    v2.steps.Reviewer = async (n) => {
      if (n < children.length) await children[n].promise;

      return text(`bounded result ${n}`);
    };

    const receipt = await open(t);

    await waitFor(t, () => calls("Reviewer").length === 2);
    await message(t, receipt.threadId, "a fresh user budget");
    await waitFor(t, () => calls("Main").length === 3);

    expect(JSON.stringify(calls("Main")[2].args.prompt)).toContain("RESULTS_PENDING");

    const actor = await parent(t, receipt.assignmentId);

    const launch = () =>
      t.mutation(api.agents.coordinate, {
        op: "launch",
        ...actor,
        toolCallId: crypto.randomUUID(),
        agent: "Reviewer",
        task: "new request cannot bypass outstanding result bound",
      });

    expect(await launch()).toMatchObject({ status: "denied", code: "RESULTS_PENDING" });
    children[0].release();
    await results(t, receipt.threadId, 1, 2);
    expect(await launch()).toMatchObject({ status: "denied", code: "RESULTS_PENDING" });
    children[1].release();
    await results(t, receipt.threadId, 2);

    // Individual results each occupy one result-work unit until claimed.
    expect(await launch()).toMatchObject({ status: "denied", code: "RESULTS_PENDING" });

    held.release();
    await drain(t);
  },
);
