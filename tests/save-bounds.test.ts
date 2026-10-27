// @vitest-environment edge-runtime
/** Progress cannot crowd out paid saves; the complete saved row has a hard cap,
 * every host string is bounded where it enters, and the largest row those
 * writer bounds admit fits the envelope. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createThread, saveMessage, listMessages } from "@convex-dev/agent";
import { componentsGeneric, createFunctionHandle, type ApiFromModules } from "convex/server";
import { getConvexSize } from "convex/values";
import agevex from "../src/test.js";
import { HOST_LIMITS, LIMITS, resolveLimits } from "../src/component/limits.js";
import schema from "../src/component/schema.js";
import { setup, components, rawAssignment } from "./setup.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([
  {
    mode: "boundary",
    guarantee: "a native save that fills the envelope exactly commits with its id",
  },
  // The post-save size check is unreachable in production (see the largest-row
  // test below); this padded fixture forces it to prove the rollback.
  { mode: "overflow", guarantee: "no assistant row commits without its id on the assignment" },
  { mode: "marker", guarantee: "a native save clears progress markers before its metadata grows" },
] as const)("$guarantee", async ({ mode }) => {
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
      failMessage: await createFunctionHandle(components.agent.messages.updateMessage),
    },
  }));

  const save = t.mutation(components.agevex.turns.slices.write, {
    assignmentId,
    executionId: "save",
    cancellationEpoch: 0,
    ...handles,
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
});

it("the largest assignment every writer bound admits fits the save envelope", async () => {
  const t = setup(undefined, undefined, true);

  t.registerComponent("agevex", agevex.schema, {
    ...agevex.modules,
    "./component/saveBounds.ts": () => import("./save-bounds.fixture.js"),
  });

  const largestRow = componentsGeneric().agevex.saveBounds.largestRow as unknown as ApiFromModules<{
    seed: typeof import("./save-bounds.fixture.js");
  }>["seed"]["largestRow"];

  const assignmentId = await t.mutation(largestRow, {});
  const row = (await t.query(rawAssignment, { assignmentId }))!;

  // Every stored field is at its cap. activeTools is the one exception: write
  // clears it before any save grows the row, and its own writer
  // (turns/tools.ts) refuses a marker that would cross the envelope.
  const fields = Object.keys(schema.tables.assignments.validator.fields).filter(
    (field) => field !== "activeTools",
  );

  expect(fields.filter((field) => row[field as keyof typeof row] === undefined)).toEqual([]);
  expect(row.turnReport?.messageIds).toHaveLength(HOST_LIMITS.slicesPerTurn.max);
  expect(row.approvals?.requests).toHaveLength(LIMITS.approvalsPerPause);
  expect(new TextEncoder().encode(row.agent).byteLength).toBe(3 * LIMITS.nameLength);
  expect(row.runTurn).toHaveLength(LIMITS.functionHandleBytes);
  expect(getConvexSize(row)).toBeLessThanOrEqual(LIMITS.assignmentBytes);
});

const wide = (units: number) => "語".repeat(units);
const longHandle = "h".repeat(LIMITS.functionHandleBytes + 1);

it("send stores names and handles at their caps and refuses one unit or byte more", async () => {
  const t = setup(undefined, undefined, true);

  const accept = (threadId: string, over: Record<string, unknown> = {}) =>
    t.mutation(components.agevex.turns.send.accept, {
      subject: wide(LIMITS.nameLength),
      agent: wide(LIMITS.nameLength),
      threadId,
      requestKey: threadId,
      fingerprint: threadId,
      promptMessageId: `${threadId}-prompt`,
      runTurn: "r".repeat(LIMITS.functionHandleBytes),
      limits: resolveLimits(),
      textConfig: {
        worker: "w".repeat(LIMITS.functionHandleBytes),
        updateThread: "u".repeat(LIMITS.functionHandleBytes),
        getThread: "g".repeat(LIMITS.functionHandleBytes),
      },
      ...over,
    });

  await expect(accept("at-cap")).resolves.toMatchObject({ status: "accepted" });

  const refused = [
    [{ subject: wide(LIMITS.nameLength + 1) }, "INVALID_SUBJECT"],
    [{ agent: wide(LIMITS.nameLength + 1) }, "INVALID_AGENT"],
    [{ runTurn: longHandle }, "INVALID_FUNCTION_HANDLE"],
    [
      {
        textConfig: {
          worker: longHandle,
          updateThread: "u",
          getThread: "g",
        },
      },
      "INVALID_FUNCTION_HANDLE",
    ],
  ] as const;

  for (const [index, [over, code]] of refused.entries())
    await expect(accept(`over-${index}`, over)).rejects.toMatchObject({ data: { code } });
});

it.each([
  ["write", "handle"],
  ["write", "nativeMessages"],
  ["write", "nativeStream"],
  ["reserve", "agent"],
  ["reserve", "coordinateHandle"],
] as const)("%s refuses an oversized %s before any write commits", async (writer, field) => {
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
    const { messageId } = await saveMessage(ctx, components.agent, { threadId, prompt: "anchor" });

    return {
      threadId,
      promptMessageId: messageId,
      handle: await createFunctionHandle(components.agent.messages.addMessages),
      getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
      finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
      failMessage: await createFunctionHandle(components.agent.messages.updateMessage),
    };
  });

  const assignmentId = await t.mutation(seed, {
    threadId: native.threadId,
    promptMessageId: native.promptMessageId,
    marker: false,
    overflow: false,
  });

  const before = (await t.query(rawAssignment, { assignmentId }))!;

  const call =
    writer === "write"
      ? t.mutation(components.agevex.turns.slices.write, {
          assignmentId,
          executionId: "save",
          cancellationEpoch: 0,
          handle: field === "handle" ? longHandle : native.handle,
          nativeMessages: {
            getMessages: native.getMessages,
            finalizeMessage: field === "nativeMessages" ? longHandle : native.finalizeMessage,
            failMessage: native.failMessage,
          },
          ...(field === "nativeStream" ? { nativeStream: longHandle } : {}),
          args: {
            threadId: native.threadId,
            promptMessageId: native.promptMessageId,
            messages: [{ message: { role: "assistant", content: "paid result" } }],
          },
        })
      : t.mutation(components.agevex.subagents.launch.reserve, {
          assignmentId,
          turnToken: "save",
          toolCallId: "call",
          agent: field === "agent" ? wide(LIMITS.nameLength + 1) : "Builder",
          payloadFingerprint: "payload",
          coordinateHandle: field === "coordinateHandle" ? longHandle : "coordinate",
        });

  await expect(call).rejects.toMatchObject({
    data: { code: field === "agent" ? "INVALID_AGENT" : "INVALID_FUNCTION_HANDLE" },
  });

  const page = await t.run((ctx) =>
    listMessages(ctx, components.agent, {
      threadId: native.threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  );

  expect(page.page.filter((m) => m.message?.role === "assistant")).toHaveLength(0);
  expect(await t.query(rawAssignment, { assignmentId })).toEqual(before);
});
