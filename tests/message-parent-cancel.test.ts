// @vitest-environment edge-runtime
/** Cancel must remove every row in the enlarged, conservative ready-work envelope. */
import { componentsGeneric, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HOST_LIMITS, readyRowLimit } from "../src/component/limits.js";
import { v2, text } from "./delegation-v2.host.js";
import {
  setup,
  open,
  owner,
  calls,
  drain,
  tree,
  waitFor,
  gate,
  api,
  rawAssignment,
  addHeadroomFixture,
  components,
} from "./message-parent.fixture.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("cancel clears 2,432 ready rows and 168 maximum-size budgets across sixteen assignments within transaction limits", async () => {
  const maxima = Object.fromEntries(
    Object.entries(HOST_LIMITS).map(([key, { max }]) => [key, max]),
  );

  const t = setup(maxima);
  const { fillCancelQueue } = addHeadroomFixture(t);
  const held = gate();
  const parentHeld = gate();

  v2.steps.Main = async () => {
    await parentHeld.promise;

    return text("cancelled parent");
  };

  v2.steps.Reviewer = async () => {
    await held.promise;

    return text("cancelled child");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Main").length === 1);
  const root = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;

  for (let index = 0; index < HOST_LIMITS.activeChildrenPerRoot.max; index++)
    expect(
      await t.mutation(api.agents.coordinate, {
        op: "launch",
        assignmentId: root._id,
        turnToken: root.turnToken!,
        toolCallId: `max-cancel-${index}`,
        agent: "Reviewer",
        task: "held for cancellation",
      }),
    ).toMatchObject({ status: "queued" });

  const runs = await tree(t, receipt.threadId);
  const ids = [receipt.assignmentId, ...runs.map((run) => run.childAssignmentId!)];

  // Claim lane-waiting task heads manually. The fixture replaces
  // only consumed work, so there is no extra task row above the 152-row bound.
  for (const assignmentId of ids) {
    const row = (await t.query(rawAssignment, { assignmentId }))!;

    if (row.turnStatus === "queued")
      await t.mutation(components.agevex.turns.slices.claim, {
        assignmentId: row._id,
        turnToken: row.turnToken!,
      });

    await t.mutation(fillCancelQueue, { assignmentId });
  }

  const queuedWork = componentsGeneric().agevex.agevexTest
    .queuedWork as unknown as FunctionReference<
    "query",
    "internal",
    Record<string, never>,
    { inbox: unknown[]; runs: { cancelled: boolean }[] }
  >;

  const before = await t.query(queuedWork, {});

  expect(before.inbox).toHaveLength(
    ids.length *
      readyRowLimit({
        queueLength: HOST_LIMITS.queueLength.max,
        runLaunches: HOST_LIMITS.runLaunches.max,
      }),
  );

  expect(before.runs).toHaveLength(168);

  const metrics = await owner(t).run(async (ctx) => {
    await ctx.runMutation(api.agents.cancel, { threadId: receipt.threadId });

    return ctx.meta.getTransactionMetrics();
  });

  expect(metrics.bytesRead.used).toBeLessThan(16 << 20);
  expect(metrics.bytesWritten.used).toBeLessThan(16 << 20);
  expect(metrics.documentsRead.used).toBeLessThan(32_000);
  expect(metrics.documentsWritten.used).toBeLessThan(16_000);
  const after = await t.query(queuedWork, {});

  expect(after.inbox).toEqual([]);
  expect(after.runs.every((run) => run.cancelled)).toBe(true);

  for (const assignmentId of ids) {
    const row = await t.query(rawAssignment, { assignmentId });

    expect(row).toMatchObject({
      cancelled: true,
      queuedMessages: 0,
    });

    expect(row?.routingAgentIndex).toBeUndefined();
  }

  held.release();
  parentHeld.release();
  await drain(t);
});
