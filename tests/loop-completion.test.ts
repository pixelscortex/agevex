// @vitest-environment edge-runtime
/** The loop itself can fail before consuming a paid step's failure result. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { internalMutationGeneric } from "convex/server";
import agevex from "../src/test.js";
import { setup, api, rawAssignment, state, components } from "./setup.js";
import { workflowCall } from "../src/testing/expect-journal.js";
import { requireReceipt } from "./receipt.js";
import { failLoop, finalizeFailure } from "./failure.fixture.js";
import { advanceUntil } from "./clock.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Hold only A's paid call; B must run without a later producer or recovery. */
async function queuedSuccessor(t: ReturnType<typeof setup>) {
  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });

  const alice = t.withIdentity({ subject: "alice" });

  const receipt = await alice
    .mutation(api.agents.open, { agent: "Main", prompt: "A", requestKey: "A" })
    .then(requireReceipt);

  await advanceUntil(
    t,
    async () =>
      !!(await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.pendingGeneration
        ?.stream,
  );

  const before = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;

  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "B must run after the loop fails",
    requestKey: "B",
  });

  state.gate = undefined;

  return { receipt, before };
}

/** Exact cleanup, failed run, rotation, and replay fences are all observable. */
async function expectSuccessor(
  t: ReturnType<typeof setup>,
  before: Awaited<ReturnType<typeof queuedSuccessor>>["before"],
) {
  const row = () => t.query(rawAssignment, { assignmentId: before._id });

  await advanceUntil(
    t,
    async () => state.calls.length === 2 && (await row())?.turnStatus === "idle",
  );

  expect(await row()).toMatchObject({ turnStatus: "idle", errorCode: null, queuedMessages: 0 });
  expect((await row())?.workflowId).not.toBe(before.workflowId);
  expect((await row())?.runId).not.toBe(before.runId);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("B must run");

  const [message] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [before.pendingGeneration!.messageId],
  });

  expect(message?.status).toBe("failed");

  expect(
    await t.mutation(components.agent.streams.abort, {
      streamId: before.pendingGeneration!.stream!.id,
      reason: "duplicate cleanup",
    }),
  ).toBe(false);

  const metadata = await workflowCall<unknown, typeof import("./fixture/schema.js").default>(
    t,
    "agevex/rootWorkflow",
    "query",
    "agevexJournal",
    "completionFailures",
  );

  expect(metadata).toEqual([]);

  await t.mutation(finalizeFailure, {
    assignmentId: before._id,
    workflowId: before.workflowId!,
    executionId: before.turnToken!,
    epoch: before.cancellationEpoch,
  });

  expect((await row())?.turnStatus).toBe("idle");

  expect(
    await t.mutation(components.agevex.turns.slices.claim, {
      assignmentId: before._id,
      turnToken: before.turnToken!,
      sliceId: "never-replay-A",
    }),
  ).toBeNull();

  expect(state.calls).toHaveLength(2);
}

it.each(["failed", "canceled"] as const)(
  "%s loop completion finalizes A once, closes its native ids and runs queued B",
  async (kind) => {
    const t = setup(undefined, undefined, true);
    const { before } = await queuedSuccessor(t);

    try {
      await failLoop(t, before._id, kind);
      await expectSuccessor(t, before);
    } finally {
      state.release!();
      await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 2000);
    }

    expect(state.calls).toHaveLength(2);
  },
);

it("a driver failure before consuming a killed slice finalizes A and starts queued B", async () => {
  const t = setup(undefined, undefined, true);
  let failDriver = false;

  t.registerComponent("agevex", agevex.schema, {
    ...agevex.modules,
    "./component/workflows/lanes.ts": async () => {
      const real = await import("../src/component/workflows/lanes.js");

      const driver = real.rootLoop as unknown as {
        _args: never;
        _returns: never;
        _handler: (ctx: unknown, args: unknown) => Promise<never>;
      };

      return {
        ...real,
        rootLoop: internalMutationGeneric({
          args: driver._args,
          returns: driver._returns,
          handler: (ctx, args) => {
            if (failDriver) {
              failDriver = false;
              throw new Error("driver died before consuming nested failure");
            }

            return driver._handler(ctx, args);
          },
        }),
      };
    },
  });

  const { before } = await queuedSuccessor(t);

  failDriver = true;

  expect(
    await workflowCall(t, "agevex/rootWorkflow", "mutation", "agevexJournal", "interrupt", {
      mode: "scheduler",
    }),
  ).toBe(1);

  await expectSuccessor(t, before);
  // A scheduler-canceled convex-test body must stay blocked. The local crash
  // probe kills the actual backend action and verifies the real recovery path.
});
