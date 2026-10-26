// @vitest-environment edge-runtime
/** Combined claim bounds include a child's repeated group recovery and native notes. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createThread, saveMessage } from "@convex-dev/agent";
import { componentsGeneric, createFunctionHandle, type ApiFromModules } from "convex/server";
import { getConvexSize } from "convex/values";
import agevex from "../src/test.js";
import { HOST_LIMITS, LIMITS } from "../src/component/limits.js";
import { setup, components, rawAssignment } from "./setup.js";
import { fillNativeHeads } from "./native-heads.fixture.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("a full 34 KiB child drains 50 deferred groups and maximum notes with six native heads within transaction limits", async () => {
  const t = setup(undefined, undefined, true);

  t.registerComponent("agevex", agevex.schema, {
    ...agevex.modules,
    "./component/claimBounds.ts": () => import("./claim-bounds.fixture.js"),
  });

  const seedRef = componentsGeneric().agevex.claimBounds.seed as unknown as ApiFromModules<{
    seed: typeof import("./claim-bounds.fixture.js");
  }>["seed"]["seed"];

  const native = await t.run(async (ctx) => {
    const threadId = await createThread(ctx, components.agent, { userId: "alice" });

    await saveMessage(ctx, components.agent, { threadId, prompt: "preceding order" });
    const { messageId } = await saveMessage(ctx, components.agent, { threadId, prompt: "anchor" });

    return { threadId, promptMessageId: messageId };
  });

  await fillNativeHeads(t, native.threadId, native.promptMessageId, -1);

  const { rootId, childId } = await t.mutation(seedRef, native);

  for (const assignmentId of [rootId, childId])
    expect(getConvexSize(await t.query(rawAssignment, { assignmentId }))).toBe(
      LIMITS.assignmentBytes,
    );

  const previous = (await t.query(rawAssignment, { assignmentId: childId }))!;

  expect(previous.turnReport?.messageIds).toHaveLength(HOST_LIMITS.slicesPerTurn.max);

  const notes = await t.run(async () => ({
    addMessages: await createFunctionHandle(components.agent.messages.addMessages),
    getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
    updateMessage: await createFunctionHandle(components.agent.messages.updateMessage),
  }));

  const metrics = await t.run(async (ctx) => {
    const claim = await ctx.runMutation(components.agevex.turns.slices.claim, {
      assignmentId: childId,
      turnToken: "claim",
      notes,
    });

    expect(claim?.subagent?.runId).toBe("claim-child");

    return ctx.meta.getTransactionMetrics();
  });

  expect(metrics.bytesRead.used).toBeLessThan(13 << 20);
  expect(metrics.bytesWritten.used).toBeLessThan(4 << 20);
  // Regression tripwires well inside those documented ceilings: measured
  // 8,351 KiB read / 1,015 KiB written, plus 25%.
  expect(metrics.bytesRead.used).toBeLessThan(10_440 << 10);
  expect(metrics.bytesWritten.used).toBeLessThan(1_270 << 10);
  expect(metrics.documentsRead.used).toBeLessThan(2_000);
  expect(metrics.documentsWritten.used).toBeLessThan(600);
  const claimed = (await t.query(rawAssignment, { assignmentId: childId }))!;

  expect(claimed).toMatchObject({ queuedMessages: 0, notesPending: 0, turnStatus: "running" });
  expect(claimed.turnReport?.messageIds).toEqual([]);
});
