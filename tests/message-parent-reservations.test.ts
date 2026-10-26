// @vitest-environment edge-runtime
/** Fake-model regressions for shared result/answer hop and control-queue capacity. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HOST_LIMITS, LIMITS } from "../src/component/limits.js";
import { v2, call, delegate, text } from "./delegation-v2.host.js";
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
  send,
  api,
  rawAssignment,
  hops,
} from "./message-parent.fixture.js";

const deliveries = async (t: ReturnType<typeof setup>, threadId: string) =>
  (
    await owner(t).query(api.agents.delegations, {
      threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    })
  ).page;

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("a launch after notes reserves its own result as well as all existing results", async () => {
  const t = setup();
  const held = gate();
  const parentHeld = gate();

  v2.steps.Main = async (n) => {
    if (n === 0) return Array.from({ length: 4 }, () => delegate("Reviewer"));

    await parentHeld.promise;

    return text("read results");
  };

  v2.steps.Reviewer = async (n) => {
    await held.promise;

    return text(`result ${n}`);
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 4);

  // Four launches +15 notes leave five hops: enough for four results, but
  // a fifth launch would also need its own result (six hops total).
  for (let note = 0; note < 15; note++) {
    if (note && note % 4 === 0)
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
      });

    expect(
      await send(t, await sender(t, receipt.threadId, note % 4), `note ${note}`),
    ).toMatchObject({ status: "accepted" });
  }

  const parent = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;

  expect(
    await t.mutation(api.agents.coordinate, {
      op: "launch",
      assignmentId: parent._id,
      turnToken: parent.turnToken!,
      toolCallId: "starving-launch",
      agent: "Reviewer",
      task: "no result capacity",
    }),
  ).toMatchObject({ status: "denied", code: "RUN_BUDGET" });

  expect(await tree(t, receipt.threadId)).toHaveLength(4);
  expect(await hops(t, receipt.assignmentId)).toBe(19);
  held.release();
  parentHeld.release();
  await drain(t);

  expect(
    (await deliveries(t, receipt.threadId)).every((run) => run.deliveryStatus === "accepted"),
  ).toBe(true);

  expect(await hops(t, receipt.assignmentId)).toBe(23);
});

it.each(["before", "after"] as const)(
  "a question opened %s notes keeps its answer and all five final results within 24 hops",
  async (when) => {
    const t = setup();
    const askHeld = gate();
    const resultsHeld = gate();
    const parentHeld = gate();

    v2.steps.Main = async (n) => {
      if (n === 0) return Array.from({ length: 5 }, () => delegate("Reviewer"));

      await parentHeld.promise;

      return text("read all five");
    };

    v2.steps.Reviewer = async (n) => {
      if (n === 0) {
        await askHeld.promise;

        return [call("agevex_ask_parent", { question: "which revision?" })];
      }

      await resultsHeld.promise;

      return text(`final result ${n}`);
    };

    const receipt = await open(t);

    await waitFor(t, () => calls("Reviewer").length === 4);

    const ask = async () => {
      askHeld.release();

      await waitFor(t, async () => {
        const run = (await tree(t, receipt.threadId))[0];

        return (
          run.status === "asking" &&
          (await t.query(rawAssignment, { assignmentId: run.childAssignmentId! }))?.turnStatus ===
            "idle"
        );
      });
    };

    if (when === "before") await ask();

    for (let round = 0; round < 4; round++) {
      for (const child of [1, 2, 3])
        expect(
          await send(t, await sender(t, receipt.threadId, child), `note ${child}/${round}`),
        ).toMatchObject({ status: "accepted" });

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
      });
    }

    if (when === "after") await ask();

    expect(await hops(t, receipt.assignmentId)).toBe(18);
    await waitFor(t, () => calls("Reviewer").length === 5);

    expect(
      await send(t, await sender(t, receipt.threadId, 4), "would steal the open answer"),
    ).toMatchObject({ status: "denied", code: "RUN_BUDGET" });

    const parent = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;
    const runs = await tree(t, receipt.threadId);

    const message = (runId: string) =>
      t.mutation(api.agents.coordinate, {
        op: "message",
        assignmentId: parent._id,
        turnToken: parent.turnToken!,
        runId,
        text: "use revision two",
      });

    expect(await message(runs[1].runId)).toMatchObject({ status: "denied", code: "RUN_BUDGET" });
    expect(await message(runs[0].runId)).toMatchObject({ status: "accepted" });
    // The four sibling lanes are occupied; free them so the answered child
    // can claim its continuation instead of waiting for a nonexistent fifth lane.
    resultsHeld.release();
    parentHeld.release();
    await drain(t);
    expect(calls("Reviewer")).toHaveLength(6);
    expect(JSON.stringify(calls("Reviewer")[5].args.prompt)).toContain("use revision two");

    expect(
      (await deliveries(t, receipt.threadId)).every((run) => run.deliveryStatus === "accepted"),
    ).toBe(true);

    expect(await tree(t, receipt.threadId)).toHaveLength(5);

    expect(
      (await transcript(t, receipt.threadId)).page.filter((row) => row.origin === "result"),
    ).toHaveLength(5);

    expect(await hops(t, receipt.assignmentId)).toBe(HOST_LIMITS.runHops.default);
  },
);

it.each(["each", "all"] as const)(
  "a wait=%s final result delivers beyond a full message queue beside an approval continuation",
  async (wait) => {
    const t = setup({ runHops: HOST_LIMITS.runHops.max, queueLength: 4 }, "approval");
    const parentHeld = gate();
    const childHeld = gate();

    v2.steps.Main = async (n) => {
      if (n === 0) return [delegate("Reviewer", { wait })];

      if (n === 1) {
        await parentHeld.promise;

        return [call("human", {}, "human-call")];
      }

      return text("approved and read all results");
    };

    v2.steps.Reviewer = async () => {
      await childHeld.promise;

      return text("result survives approval pause");
    };

    const receipt = await open(t);

    await waitFor(t, () => calls("Reviewer").length === 1);
    const actor = await sender(t, receipt.threadId);

    expect(await send(t, actor, "wake parent")).toMatchObject({ status: "accepted" });
    await waitFor(t, () => calls("Main").length === 2);

    for (let note = 0; note < 3; note++) {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
      });

      expect(await send(t, actor, `queued note ${note}`)).toMatchObject({ status: "accepted" });
    }

    parentHeld.release();

    await waitFor(
      t,
      async () =>
        !!(
          await t.query(rawAssignment, {
            assignmentId: receipt.assignmentId,
          })
        )?.approvalBlocked,
    );

    expect(
      (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.queuedMessages,
    ).toBe(4);

    childHeld.release();

    await waitFor(
      t,
      async () => (await deliveries(t, receipt.threadId))[0].deliveryStatus === "accepted",
    );

    // Three messages +one exact approval continuation +one owed result;
    // delivery never needs a free message slot beside the control row.
    expect(
      (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.queuedMessages,
    ).toBe(5);

    expect(JSON.stringify(await transcript(t, receipt.threadId))).toContain(
      "result survives approval pause",
    );

    await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
    await drain(t);
  },
);
