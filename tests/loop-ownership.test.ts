// @vitest-environment edge-runtime
/** Every loop rotation settles its captured running turn and preserves successors. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { internalMutationGeneric } from "convex/server";
import agevex from "../src/test.js";
import { setup, api, components, rawAssignment, state } from "./setup.js";
import { workflowCall } from "../src/testing/expect-journal.js";
import { requireReceipt } from "./receipt.js";
import { advanceUntil } from "./clock.js";
import { failLoop } from "./failure.fixture.js";

type Test = ReturnType<typeof setup>;
type Assignment = NonNullable<Awaited<ReturnType<typeof pendingTurn>>>;
type Schema = typeof import("./fixture/schema.js").default;

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** The native placeholder and stream exist before the paid action is released. */
async function pendingTurn(t: Test) {
  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });

  const receipt = await t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.open, { agent: "Main", prompt: "A", requestKey: "A" })
    .then(requireReceipt);

  await advanceUntil(
    t,
    async () =>
      !!(await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.pendingGeneration
        ?.stream,
  );

  return (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;
}

/** B is queued independently of A's paid result and can run after ownership ends. */
async function queueB(t: Test, row: Assignment) {
  await t.withIdentity({ subject: "alice" }).mutation(api.agents.send, {
    threadId: row.threadId,
    text: "B survives the old loop",
    requestKey: "B",
  });

  state.gate = undefined;
}

/** Complete through Workflow's real onComplete mutation, including rotation. */
async function completeSuccessfully(t: Test, workflowId: string) {
  await workflowCall(t, "agevex/rootWorkflow", "mutation", "workflow", "complete", {
    workflowId,
    generationNumber: 0,
    runResult: { kind: "success", returnValue: null },
  });
}

/** Both orphan paths must fail A's exact native state and admit unrelated B. */
async function expectOrphanSettled(t: Test, row: Assignment) {
  await advanceUntil(t, async () => {
    const current = await t.query(rawAssignment, { assignmentId: row._id });

    return state.calls.length === 2 && current?.turnStatus === "idle";
  });

  const [message] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [row.pendingGeneration!.messageId],
  });

  expect(message?.status).toBe("failed");

  expect(
    await t.mutation(components.agent.streams.abort, {
      streamId: row.pendingGeneration!.stream!.id,
      reason: "duplicate cleanup",
    }),
  ).toBe(false);

  expect(JSON.stringify(state.calls[1].prompt)).toContain("B survives");
}

it.each(["nested return", "final iteration"] as const)(
  "a successful %s cannot rotate or wait while its captured turn is still running",
  async (boundary) => {
    const t = setup(undefined, undefined, true);
    const row = await pendingTurn(t);

    await queueB(t, row);

    try {
      if (boundary === "nested return") {
        const turns = await workflowCall<{ id: string; args: { executionId?: string } }[], Schema>(
          t,
          "agevex/rootWorkflow",
          "query",
          "agevexJournal",
          "turns",
        );

        const nested = turns.find((turn) => turn.args.executionId === row.turnToken)!;

        await completeSuccessfully(t, nested.id);
      } else {
        await workflowCall(
          t,
          "agevex/rootWorkflow",
          "mutation",
          "agevexJournal",
          "fillCompletionHistory",
          {
            workflowId: row.workflowId,
          },
        );

        await completeSuccessfully(t, row.workflowId!);
      }

      await expectOrphanSettled(t, row);
    } finally {
      state.release!();
      await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 2000);
    }

    expect(state.calls).toHaveLength(2);
  },
);

/** Hold the driver after A finishes, before it can capture the reserved B. */
function holdDriver(t: Test) {
  let held = false;

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
          handler: (ctx, args) =>
            held ? Promise.resolve(null as never) : driver._handler(ctx, args),
        }),
      };
    },
  });

  return (value: boolean) => {
    held = value;
  };
}

it.each(["failed", "canceled"] as const)(
  "%s completion after A finishes preserves B's reserved execution",
  async (kind) => {
    const t = setup(undefined, undefined, true);
    const hold = holdDriver(t);
    const row = await pendingTurn(t);

    await queueB(t, row);
    hold(true);
    state.release!();

    await advanceUntil(t, async () => {
      const current = await t.query(rawAssignment, { assignmentId: row._id });

      return current?.turnStatus === "queued" && current.turnToken !== row.turnToken;
    });

    const successor = (await t.query(rawAssignment, { assignmentId: row._id }))!;

    hold(false);
    await failLoop(t, row._id, kind);

    await advanceUntil(
      t,
      async () => (await t.query(rawAssignment, { assignmentId: row._id }))?.turnStatus === "idle",
    );

    const current = (await t.query(rawAssignment, { assignmentId: row._id }))!;

    expect(current.runId).toBe(successor.runId);
    expect(current.errorCode).toBeNull();
    expect(state.calls).toHaveLength(2);
    expect(JSON.stringify(state.calls[1].prompt)).toContain("B survives");
  },
);
