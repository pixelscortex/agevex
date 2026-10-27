// @vitest-environment edge-runtime
/** Crashed-turn cleanup stays bounded even when native recovery cannot retain output. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { componentsGeneric, type ApiFromModules, type FunctionReference } from "convex/server";
import { getConvexSize } from "convex/values";
import agevex from "../src/test.js";
import { HOST_LIMITS, LIMITS } from "../src/component/limits.js";
import { setup, api, components, rawAssignment, state } from "./setup.js";
import { advanceUntil } from "./clock.js";
import { workflowCall } from "../src/testing/expect-journal.js";
import { requireReceipt } from "./receipt.js";

type Test = ReturnType<typeof setup>;
const BOUNDS = { deltaBytes: 1020 << 10, readBytes: 7_600 << 10 } as const;

const seedBacklog = componentsGeneric().agevex.failureBounds
  .seedBacklog as unknown as ApiFromModules<{
  fixture: typeof import("./failure-bounds.fixture.js");
}>["fixture"]["seedBacklog"];

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Agent stores both content and its text projection, so each ASCII byte grows
 * the document by two bytes. Fill to within one byte of the 1 MiB ceiling.
 */
async function fillPlaceholder(t: Test, messageId: string) {
  const content = "x".repeat(510 << 10);

  const message = await t.mutation(components.agent.messages.updateMessage, {
    messageId,
    patch: { message: { role: "assistant", content } },
  });

  const remaining = Math.floor(((1 << 20) - getConvexSize(message)) / 2);

  const full = await t.mutation(components.agent.messages.updateMessage, {
    messageId,
    patch: { message: { role: "assistant", content: content + "x".repeat(remaining) } },
  });

  expect(getConvexSize(full)).toBeGreaterThanOrEqual((1 << 20) - 1);
}

/** Paid output can exceed a transaction: failure must never materialize it. */
async function fillStream(t: Test, streamId: string, count: number) {
  for (let i = 0; i < count; i++)
    await t.mutation(components.agent.streams.addDelta, {
      streamId,
      start: i,
      end: i + 1,
      parts: [
        ...(i === 0 ? [{ type: "start" }, { type: "text-start", id: "large" }] : []),
        { type: "text-delta", id: "large", delta: "x".repeat(BOUNDS.deltaBytes) },
        ...(i === count - 1 ? [{ type: "text-end", id: "large" }] : []),
      ],
    });
}

/** Recovery would also read these six heads; exact failure must ignore them. */
async function fillMergeHeads(t: Test, threadId: string) {
  for (const status of ["success", "pending", "failed"] as const)
    for (const tool of [false, true])
      await t.mutation(components.agent.messages.addMessages, {
        threadId,
        failPendingSteps: false,
        messages: [
          {
            status,
            message: tool
              ? {
                  role: "tool",
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: `large-${status}`,
                      toolName: "echo",
                      output: { type: "text", value: "x".repeat(1020 << 10) },
                    },
                  ],
                }
              : { role: "user", content: "x".repeat(510 << 10) },
          },
        ],
      });
}

/** Assert exact native ids, never a transcript scan that could mask stale cleanup. */
async function expectClosed(t: Test, messageId: string, streamId: string) {
  const [message] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [messageId],
  });

  expect(message?.status).toBe("failed");

  expect(
    await t.mutation(components.agent.streams.abort, { streamId, reason: "already closed" }),
  ).toBe(false);
}

it.each(["overflow", "reconstruct"] as const)(
  "%s full loop completion closes maximum native state, ready backlog and journal within one transaction",
  async (mode) => {
    const t = setup(
      undefined,
      { queueLength: HOST_LIMITS.queueLength.max, runLaunches: HOST_LIMITS.runLaunches.max },
      true,
    );

    t.registerComponent("agevex", agevex.schema, {
      ...agevex.modules,
      "./component/failureBounds.ts": () => import("./failure-bounds.fixture.js"),
    });

    state.gate = new Promise((resolve) => {
      state.release = resolve;
    });

    const receipt = await t
      .withIdentity({ subject: "alice" })
      .mutation(api.agents.open, { agent: "Main", prompt: "bounded crash", requestKey: "bounds" })
      .then(requireReceipt);

    await advanceUntil(
      t,
      async () =>
        !!(await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.pendingGeneration
          ?.stream,
    );

    const row = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;
    const pending = row.pendingGeneration!;

    try {
      expect(await t.mutation(seedBacklog, { assignmentId: row._id })).toBe(152);

      await fillPlaceholder(t, pending.messageId);

      expect(
        await workflowCall(
          t,
          "agevex/rootWorkflow",
          "mutation",
          "agevexJournal",
          "fillCompletionHistory",
          { workflowId: row.workflowId },
        ),
      ).toBe(LIMITS.turnsPerLoop * 2);

      if (mode === "reconstruct") await fillMergeHeads(t, row.threadId);

      await fillStream(t, pending.stream!.id, mode === "overflow" ? 20 : 8);

      const metrics = await t.run(async (ctx) => {
        await ctx.runMutation(
          componentsGeneric().agevex.agevexTest.write as unknown as FunctionReference<"mutation">,
          {
            lane: "rootWorkflow",
            module: "workflow",
            name: "complete",
            args: {
              workflowId: row.workflowId!,
              generationNumber: 0,
              runResult: { kind: "failed", error: "loop driver failed at its largest journal" },
            },
          },
        );

        return ctx.meta.getTransactionMetrics();
      });

      expect(metrics.bytesRead.used).toBeLessThan(BOUNDS.readBytes);
      expect(metrics.bytesWritten.used).toBeLessThan(2 << 20);
      await expectClosed(t, pending.messageId, pending.stream!.id);
      const failed = (await t.query(rawAssignment, { assignmentId: row._id }))!;

      expect(failed).toMatchObject({
        errorCode: "EXECUTION_AMBIGUOUS",
        queuedMessages: 0,
      });

      expect(failed.pendingGeneration).toBeUndefined();
      expect(failed.workflowId).not.toBe(row.workflowId);

      expect(
        await workflowCall(
          t,
          "agevex/rootWorkflow",
          "query",
          "agevexJournal",
          "completionFailures",
        ),
      ).toEqual([]);
    } finally {
      state.release!();
      state.gate = undefined;
      await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 2000);
    }

    expect(state.calls).toHaveLength(1);
  },
);
