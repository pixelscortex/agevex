// @vitest-environment edge-runtime
// Maximum query reads use distinct native documents so deduplication cannot hide cost.
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { componentsGeneric, createFunctionHandle, type FunctionReference } from "convex/server";
import { getConvexSize } from "convex/values";
import agevex from "../../src/test.js";
import { HOST_LIMITS, LIMITS } from "../../src/component/limits.js";
import { DECISION_LIMITS } from "../../src/shared/decisions.js";
import { setup, api, native } from "./setup.js";
import { requireReceipt } from "../receipt.js";

agevex.modules["./component/decisionFixture.ts"] = () => import("../decisions-bounds.fixture.js");

const fixture = componentsGeneric().agevex.decisionFixture as unknown as {
  seed: FunctionReference<
    "mutation",
    "internal",
    {
      root: string;
      getMessages: string;
      addMessages: string;
      sources: { threadId: string; messageIds: string[] }[];
    },
    null
  >;
};

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("pending decisions read 256 compact proposals below 8 MiB even with large native reasoning", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });

  const root = requireReceipt(
    await alice.mutation(api.host.open, { agent: "Tools", prompt: "work", requestKey: "work" }),
  );

  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
  const sources = [];

  for (let offset = 0; offset <= HOST_LIMITS.activeChildrenPerRoot.max; offset++) {
    const threadId = offset
      ? (await t.mutation(native.threads.createThread, {}))._id
      : root.threadId;

    const messageIds = [];

    for (let index = 0; index < LIMITS.approvalsPerPause; index++) {
      const saved = await t.mutation(native.messages.addMessages, {
        threadId,
        failPendingSteps: false,
        messages: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "reasoning", text: "r".repeat(20 << 10) },
                {
                  type: "tool-call",
                  toolName: "editable_echo",
                  toolCallId: `call-${offset}-${index}`,
                  input: { text: "x".repeat(15 << 10) },
                },
                {
                  type: "tool-approval-request",
                  approvalId: `approval-${offset}-${index}`,
                  toolCallId: `call-${offset}-${index}`,
                },
              ],
            },
          },
        ],
      });

      expect(getConvexSize(saved.messages[0])).toBeGreaterThan(20 << 10);
      expect(getConvexSize(saved.messages[0])).toBeGreaterThan(15 << 10);
      messageIds.push(saved.messages[0]._id);
    }

    sources.push({ threadId, messageIds });
  }

  const handles = await t.run(async () => ({
    getMessages: await createFunctionHandle(native.messages.getMessagesByIds),
    addMessages: await createFunctionHandle(native.messages.addMessages),
  }));

  await t.mutation(fixture.seed, { root: root.assignmentId, ...handles, sources });

  const { result, bytes } = await alice.run(async (ctx) => {
    const result = await ctx.runQuery(api.host.pendingApprovals, { threadId: root.threadId });

    return { result, bytes: (await ctx.meta.getTransactionMetrics()).bytesRead.used };
  });

  expect(result).toHaveLength(256);
  expect(new Set(result.map((item) => item.toolCallId)).size).toBe(256);

  expect(getConvexSize(result as import("convex/values").Value)).toBeLessThanOrEqual(
    DECISION_LIMITS.outputBytes,
  );

  expect(bytes).toBeLessThan(8 << 20);
  expect(bytes).toBeGreaterThan(4 << 20);
});
