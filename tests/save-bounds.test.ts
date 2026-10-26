// @vitest-environment edge-runtime
/** Progress cannot crowd out paid saves; the complete saved row has a hard cap. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createThread, saveMessage, listMessages } from "@convex-dev/agent";
import { componentsGeneric, createFunctionHandle, type ApiFromModules } from "convex/server";
import { getConvexSize } from "convex/values";
import agevex from "../src/test.js";
import { LIMITS } from "../src/component/limits.js";
import { setup, components, rawAssignment } from "./setup.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["boundary", "overflow", "marker"] as const)(
  "native save enforces the complete assignment envelope at %s",
  async (mode) => {
    const t = setup(undefined, undefined, true);

    t.registerComponent("agevex", agevex.schema, {
      ...agevex.modules,
      "./component/saveBounds.ts": () => import("./save-bounds.fixture.js"),
    });

    const seed = componentsGeneric().agevex.saveBounds.seed as unknown as ApiFromModules<{
      seed: typeof import("./save-bounds.fixture.js");
    }>["seed"]["seed"];

    const native = await t.run(async (ctx) => {
      const threadId = await createThread(ctx, components.agent, { userId: "alice" });

      const { messageId } = await saveMessage(ctx, components.agent, {
        threadId,
        prompt: "anchor",
      });

      return { threadId, promptMessageId: messageId };
    });

    const assignmentId = await t.mutation(seed, {
      ...native,
      marker: mode === "marker",
      overflow: mode === "overflow",
    });

    const handles = await t.run(async () => ({
      handle: await createFunctionHandle(components.agent.messages.addMessages),
      nativeMessages: {
        getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
        finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
      },
    }));

    const save = t.mutation(components.agevex.turns.slices.write, {
      assignmentId,
      executionId: "save",
      cancellationEpoch: 0,
      ...handles,
      trackUsage: true,
      args: {
        threadId: native.threadId,
        promptMessageId: native.promptMessageId,
        messages: [
          {
            message: { role: "assistant", content: "paid result" },
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        ],
      },
    });

    if (mode === "overflow") await expect(save).rejects.toThrow("ASSIGNMENT_METADATA_TOO_LARGE");
    else await save;

    const row = (await t.query(rawAssignment, { assignmentId }))!;

    const page = await t.run((ctx) =>
      listMessages(ctx, components.agent, {
        threadId: native.threadId,
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    );

    expect(page.page.filter((m) => m.message?.role === "assistant")).toHaveLength(
      mode === "overflow" ? 0 : 1,
    );

    expect(row.turnReport?.messageIds).toHaveLength(mode === "overflow" ? 63 : 64);
    expect(getConvexSize(row)).toBeLessThanOrEqual(LIMITS.assignmentBytes);

    if (mode === "boundary") expect(getConvexSize(row)).toBe(LIMITS.assignmentBytes);

    if (mode === "marker") expect(row.activeTools).toBeUndefined();
  },
);
