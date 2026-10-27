// @vitest-environment edge-runtime
/** Failure completion comes from real Workflow/Workpool, never a turn alarm. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { componentsGeneric, type FunctionReference, type ApiFromModules } from "convex/server";
import agevex from "../src/test.js";
import { setup, api, rawAssignment, state, components } from "./setup.js";
import { workflowCall } from "../src/testing/expect-journal.js";
import { requireReceipt } from "./receipt.js";
import { finalizeFailure } from "./failure.fixture.js";
import { advanceUntil } from "./clock.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 2000);

const assignment = (t: ReturnType<typeof setup>, id: string) =>
  t.query(rawAssignment, { assignmentId: id });

/** Seed only ready metadata; native content already belongs to Agent. */
function backlog(t: ReturnType<typeof setup>) {
  t.registerComponent("agevex", agevex.schema, {
    ...agevex.modules,
    "./component/failureBounds.ts": () => import("./failure-bounds.fixture.js"),
  });

  return componentsGeneric().agevex.failureBounds.seedResult as unknown as ApiFromModules<{
    fixture: typeof import("./failure-bounds.fixture.js");
  }>["fixture"]["seedResult"];
}

/** The indexed delegation projection exposes exact child ids to this fixture. */
function childAssignments(t: ReturnType<typeof setup>, threadId: string) {
  return t.query(
    componentsGeneric().agevex.agevexTest.delegationState as unknown as FunctionReference<
      "query",
      "internal",
      { threadId: string },
      { childAssignmentId: string }[]
    >,
    { threadId },
  );
}

/** Assert native cleanup by its recorded ids, without scanning a transcript. */
async function expectNativeClosed(
  t: ReturnType<typeof setup>,
  pending: NonNullable<
    import("../src/component/_generated/dataModel.js").Doc<"assignments">["pendingGeneration"]
  >,
) {
  const [message] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [pending.messageId],
  });

  expect(message?.status).toBe("failed");

  // Abort is exact-id and idempotent: false means the finalizer already
  // closed this stream; another generation's stream cannot satisfy it.
  expect(
    await t.mutation(components.agent.streams.abort, {
      streamId: pending.stream!.id,
      reason: "duplicate test abort",
    }),
  ).toBe(false);
}

it.each(["scheduler", "failed", "canceled"] as const)(
  "%s step completion fails once, closes the exact native generation and never repeats a paid call",
  async (mode) => {
    const t = setup(undefined, undefined, true);
    const alice = t.withIdentity({ subject: "alice" });

    state.gate = new Promise((resolve) => {
      state.release = resolve;
    });

    const receipt = await alice
      .mutation(api.agents.open, {
        agent: "Main",
        prompt: "interrupted generation",
        requestKey: "crash",
      })
      .then(requireReceipt);

    await advanceUntil(
      t,
      async () => !!(await assignment(t, receipt.assignmentId))?.pendingGeneration?.stream,
    );

    const before = (await assignment(t, receipt.assignmentId))!;
    const pending = before.pendingGeneration!;

    const fence = {
      assignmentId: receipt.assignmentId,
      workflowId: before.workflowId!,
      executionId: before.turnToken!,
      epoch: before.cancellationEpoch,
    };

    try {
      expect(
        await workflowCall(t, "agevex/rootWorkflow", "mutation", "agevexJournal", "interrupt", {
          mode,
        }),
      ).toBe(1);

      await advanceUntil(
        t,
        async () => (await assignment(t, receipt.assignmentId))?.turnStatus === "recovery_required",
      );

      const failed = (await assignment(t, receipt.assignmentId))!;

      expect(failed).toMatchObject({
        errorCode: "EXECUTION_AMBIGUOUS",
        lastSlice: { active: false },
        modelSteps: 1,
      });

      expect(failed.pendingGeneration).toBeUndefined();

      expect(
        await t.query(components.agevex.turns.slices.usageReporting, { runId: before.runId! }),
      ).toBe(true);

      await expectNativeClosed(t, pending);

      await t.mutation(finalizeFailure, fence);
      expect((await assignment(t, receipt.assignmentId))?.errorCode).toBe("EXECUTION_AMBIGUOUS");

      expect(
        await t.mutation(components.agevex.turns.slices.claim, {
          assignmentId: receipt.assignmentId,
          turnToken: fence.executionId,
          sliceId: "replay",
        }),
      ).toBeNull();

      expect(state.calls).toHaveLength(1);
    } finally {
      // convex-test rejects a scheduler-canceled action if its body returns.
      // Leave that injected body blocked; the backend probe tests the real kill.
      if (mode !== "scheduler") {
        state.release!();
        state.gate = undefined;
        await drain(t);
      }
    }

    expect(state.calls).toHaveLength(1);

    const jobs = await t.query(
      componentsGeneric().agevex.agevexTest.scheduledJobs as unknown as FunctionReference<"query">,
      {},
    );

    expect(jobs).toEqual({ total: 0, pending: 0 });
  },
);

it("stale workflow, token and epoch completions cannot close a current native generation", async () => {
  const t = setup();

  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });

  const receipt = await t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.open, { agent: "Main", prompt: "fences", requestKey: "fences" })
    .then(requireReceipt);

  await advanceUntil(
    t,
    async () => !!(await assignment(t, receipt.assignmentId))?.pendingGeneration,
  );

  const row = (await assignment(t, receipt.assignmentId))!;

  const fence = {
    assignmentId: receipt.assignmentId,
    workflowId: row.workflowId!,
    executionId: row.turnToken!,
    epoch: row.cancellationEpoch,
  };

  try {
    for (const stale of [
      { workflowId: "old" },
      { executionId: "old" },
      { epoch: fence.epoch + 1 },
    ]) {
      await t.mutation(finalizeFailure, { ...fence, ...stale });

      expect((await assignment(t, receipt.assignmentId))?.pendingGeneration).toEqual(
        row.pendingGeneration,
      );

      expect(await assignment(t, receipt.assignmentId)).toMatchObject({
        turnStatus: "running",
        errorCode: null,
        modelSteps: 1,
      });
    }
  } finally {
    state.release!();
    state.gate = undefined;
    await drain(t);
  }

  expect(state.calls).toHaveLength(1);
});

it("a failed paid step preserves its run error and releases an unrelated queued root request", async () => {
  const t = setup();
  const seedResult = backlog(t);

  const alice = t.withIdentity({ subject: "alice" });

  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });

  const receipt = await alice
    .mutation(api.agents.open, { agent: "Main", prompt: "fails", requestKey: "failed-request" })
    .then(requireReceipt);

  await advanceUntil(
    t,
    async () => !!(await assignment(t, receipt.assignmentId))?.pendingGeneration,
  );

  const before = (await assignment(t, receipt.assignmentId))!;

  // A same-request result ahead of B must neither block B nor restart the
  // ambiguous request. Its native content is already durable in history.
  await t.mutation(seedResult, { assignmentId: before._id });

  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "independent later request",
    requestKey: "later-request",
  });

  // Only the first model call is held. The new request must run without an
  // operator recovery, a replacement send, or replaying the interrupted call.
  state.gate = undefined;

  try {
    await workflowCall(t, "agevex/rootWorkflow", "mutation", "agevexJournal", "interrupt", {
      mode: "failed",
    });

    await advanceUntil(
      t,
      async () =>
        state.calls.length === 2 &&
        (await assignment(t, receipt.assignmentId))?.turnStatus === "idle",
    );

    expect((await assignment(t, receipt.assignmentId))?.runId).not.toBe(before.runId);

    expect(
      await t.query(components.agevex.turns.slices.usageReporting, { runId: before.runId! }),
    ).toBe(true);

    expect(JSON.stringify(state.calls[1].prompt)).toContain("independent later request");

    // A result arriving after B has finished is subject to the same fence.
    await t.mutation(seedResult, {
      assignmentId: before._id,
      runId: before.runId!,
      messageId: before.promptMessageId!,
    });

    await alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "third independent request",
      requestKey: "third",
    });

    await advanceUntil(
      t,
      async () =>
        state.calls.length === 3 &&
        (await assignment(t, receipt.assignmentId))?.turnStatus === "idle",
    );

    await t.mutation(finalizeFailure, {
      assignmentId: before._id,
      workflowId: before.workflowId!,
      executionId: before.turnToken!,
      epoch: before.cancellationEpoch,
    });

    expect((await assignment(t, receipt.assignmentId))?.turnStatus).toBe("idle");
  } finally {
    state.release!();
    await drain(t);
  }

  expect(state.calls).toHaveLength(3);
});

it("a throwing failure finalizer is recorded upstream without an agevex repair job or paid retry", async () => {
  const t = setup("failureFinalization");

  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });

  const receipt = await t
    .withIdentity({ subject: "alice" })
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "failed finalizer",
      requestKey: "failed-finalizer",
    })
    .then(requireReceipt);

  await advanceUntil(
    t,
    async () => !!(await assignment(t, receipt.assignmentId))?.pendingGeneration,
  );

  try {
    await workflowCall(t, "agevex/rootWorkflow", "mutation", "agevexJournal", "interrupt", {
      mode: "failed",
    });

    await advanceUntil(
      t,
      async () =>
        (
          await workflowCall<unknown[], typeof import("./fixture/schema.js").default>(
            t,
            "agevex/rootWorkflow",
            "query",
            "agevexJournal",
            "completionFailures",
          )
        ).length === 1,
    );

    expect((await assignment(t, receipt.assignmentId))?.turnStatus).toBe("running");
    expect(state.calls).toHaveLength(1);

    expect(
      await t.query(
        componentsGeneric().agevex.agevexTest
          .scheduledJobs as unknown as FunctionReference<"query">,
        {},
      ),
    ).toEqual({ total: 0, pending: 0 });
  } finally {
    state.release!();
    state.gate = undefined;
    await drain(t);
  }
});

it("an action that finishes then throws cannot fail or discard its queued successor", async () => {
  const t = setup("afterTurn", undefined, true);
  const alice = t.withIdentity({ subject: "alice" });

  state.gate = new Promise((resolve) => {
    state.release = resolve;
  });

  const receipt = await alice
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "finishes before throwing",
      requestKey: "late-failure",
    })
    .then(requireReceipt);

  await advanceUntil(
    t,
    async () => !!(await assignment(t, receipt.assignmentId))?.pendingGeneration,
  );

  await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "must survive",
    requestKey: "successor",
  });

  state.gate = undefined;
  state.release!();
  await drain(t);

  expect(state.calls).toHaveLength(2);
  expect(JSON.stringify(state.calls[1].prompt)).toContain("must survive");

  expect(await assignment(t, receipt.assignmentId)).toMatchObject({
    turnStatus: "idle",
    errorCode: null,
    queuedMessages: 0,
    nextTurn: 2,
  });
});

it("a failed child Workpool step closes its native generation and reaches the parent once", async () => {
  const t = setup(undefined, undefined, true);
  const alice = t.withIdentity({ subject: "alice" });

  state.delegate = true;

  state.childGate = new Promise((resolve) => {
    state.childRelease = resolve;
  });

  const receipt = await alice
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "delegate then fail",
      requestKey: "child-crash",
    })
    .then(requireReceipt);

  const children = () => childAssignments(t, receipt.threadId);

  await advanceUntil(t, async () => {
    const [child] = await children();

    return !!child && !!(await assignment(t, child.childAssignmentId))?.pendingGeneration?.stream;
  });

  const [child] = await children();
  const before = (await assignment(t, child.childAssignmentId))!;

  try {
    expect(
      await workflowCall(t, "agevex/childWorkflow", "mutation", "agevexJournal", "interrupt", {
        mode: "failed",
      }),
    ).toBe(1);

    await advanceUntil(
      t,
      async () =>
        (await alice.query(api.agents.activity, { threadId: receipt.threadId })).subagents
          .active === 0,
    );

    const history = await alice.query(api.agents.delegations, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 20 },
    });

    expect(history.page[0]).toMatchObject({
      status: "failed",
      errorCode: "EXECUTION_AMBIGUOUS",
      deliveryStatus: "accepted",
    });

    expect(history.page[0].events.filter((event) => event.phase === "failed")).toHaveLength(1);
    await expectNativeClosed(t, before.pendingGeneration!);

    await t.mutation(finalizeFailure, {
      assignmentId: before._id,
      workflowId: before.workflowId!,
      executionId: before.turnToken!,
      epoch: before.cancellationEpoch,
    });

    state.delegate = false;

    await alice.mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "later independent work",
      requestKey: "after-child-crash",
    });

    await advanceUntil(
      t,
      async () =>
        state.calls.length === 3 &&
        (await assignment(t, receipt.assignmentId))?.turnStatus === "idle",
    );

    expect(state.offers.filter((offer) => offer.agent === "Researcher")).toHaveLength(1);
  } finally {
    state.childRelease!();
    state.childGate = undefined;
    await drain(t);
  }
});
