/** Public reactive tree promises, with native fake models and enforced read ceilings. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { v2, text, call, delegate } from "./delegation-v2.host.js";
import {
  setup,
  open,
  owner,
  read,
  drain,
  progress,
  gate,
  fixture,
  api,
} from "./run-tree.fixture.js";
import { waitFor } from "./message-parent.fixture.js";
import { components, rawAssignment } from "./fixture/api.js";
import { TREE_LIMITS } from "../src/component/run-tree-values.js";
import { HOST_LIMITS, LIMITS } from "../src/component/limits.js";
import { seedUsage } from "./run-tree-meter.seed.js";
import { RUN_LIMITS } from "../src/component/run-settings.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("one query renders root and nested children, live tool updates and honest sleeping parents", async () => {
  const { t } = setup();
  const writer = gate();
  const reviewer = gate();

  progress.gates.set("card", writer);
  v2.steps.Main = (n) => (n === 0 ? [delegate("Builder")] : text("main done"));

  v2.steps.Builder = (n) =>
    n === 0 ? [delegate("Reviewer"), call("write_card", { label: "card" })] : text("builder done");

  v2.steps.Reviewer = async () => {
    await reviewer.promise;

    return text("reviewed");
  };

  const receipt = await open(t, "界".repeat(1000));
  const initial = (await read(t, receipt.threadId))!;

  expect(initial.nodes).toHaveLength(1);
  expect(initial.nodes[0].status).toBe("queued");
  expect(new TextEncoder().encode(initial.nodes[0].task).length).toBeLessThanOrEqual(256);
  expect(initial.nodes[0].messages.taskId).toBeTruthy();
  expect(initial.usage).toBeNull();

  await waitFor(
    t,
    () => progress.started.includes("card") && v2.calls.some((c) => c.agent === "Reviewer"),
  );

  const active = (await read(t, receipt.threadId))!;
  const [root, builder, child] = active.nodes;

  expect(root).toMatchObject({
    id: active.rootRunId,
    parentId: null,
    status: "asleep",
    reason: "children",
  });

  expect(builder).toMatchObject({
    parentId: root.id,
    status: "running",
    currentTool: "write_card",
  });

  expect(child).toMatchObject({ parentId: builder.id, status: "running" });
  expect(active.nodes.every((node) => node.usage === null)).toBe(true);
  writer.release();
  await waitFor(t, async () => (await read(t, receipt.threadId))!.nodes[1].status === "asleep");

  expect((await read(t, receipt.threadId))!.nodes[1]).toMatchObject({
    reason: "children",
    currentTool: null,
  });

  reviewer.release();
  await drain(t);
  const done = (await read(t, receipt.threadId))!;

  expect(
    done.nodes.every(
      (node) => node.status === "done" && node.currentTool === null && node.finishedAt !== null,
    ),
  ).toBe(true);

  expect(done.nodes.every((node) => node.startedAt !== null)).toBe(true);
});

it.each(["approval", "ask"] as const)(
  "a parent waiting on %s is asleep with that reason",
  async (boundary) => {
    const { t } = setup({ boundary });

    v2.steps.Main = (n) => (n === 0 ? [call("human", {})] : text("answered"));
    const receipt = await open(t);

    await waitFor(t, async () => (await read(t, receipt.threadId))!.nodes[0].status === "asleep");

    expect((await read(t, receipt.threadId))!.nodes[0]).toMatchObject({
      status: "asleep",
      reason: boundary,
      currentTool: null,
      finishedAt: null,
    });

    await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
    await drain(t);
  },
);

it("an open child question projects asleep with reason ask", async () => {
  const { t } = setup();
  const parent = gate();

  v2.steps.Main = async (n) => {
    if (n === 0) return [delegate("Builder")];

    await parent.promise;

    return text("answer later");
  };

  v2.steps.Builder = () => [call("agevex_ask_parent", { question: "Which card?" })];
  const receipt = await open(t);

  await waitFor(t, async () => (await read(t, receipt.threadId))?.nodes[1]?.reason === "ask");

  expect((await read(t, receipt.threadId))!.nodes[1]).toMatchObject({
    status: "asleep",
    reason: "ask",
    currentTool: null,
  });

  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  parent.release();
  await drain(t);
});

it("cancelled nodes fail and stale tool edges cannot resurrect progress", async () => {
  const { t } = setup();
  const writer = gate();

  progress.gates.set("cancel", writer);
  v2.steps.Main = (n) => (n === 0 ? [call("write_card", { label: "cancel" })] : text("done"));
  const receipt = await open(t);

  await waitFor(t, () => progress.started.includes("cancel"));
  const row = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;

  const marker = {
    assignmentId: row._id,
    turnToken: row.turnToken!,
    sliceId: row.lastSlice,
    key: "f".repeat(64),
    name: "write_card",
  };

  expect((await read(t, receipt.threadId))!.nodes[0].currentTool).toBe("write_card");
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  await t.mutation(components.agevex.turns.tools.mark, marker);

  expect((await read(t, receipt.threadId))!.nodes[0]).toMatchObject({
    status: "failed",
    reason: "cancelled",
    currentTool: null,
  });

  writer.release();
  await drain(t);
  expect((await read(t, receipt.threadId))!.nodes[0].currentTool).toBeNull();
});

it("concurrent markers reveal the last-started still-active tool and slice fences clear them", async () => {
  const { t } = setup();
  const model = gate();

  v2.steps.Main = async () => {
    await model.promise;

    return text("done");
  };

  const receipt = await open(t);

  await waitFor(t, () => v2.calls.length > 0);
  const row = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;
  const identity = { assignmentId: row._id, turnToken: row.turnToken!, sliceId: row.lastSlice };
  const first = { ...identity, key: "a".repeat(64) };
  const second = { ...identity, key: "b".repeat(64) };

  await t.mutation(components.agevex.turns.tools.mark, { ...first, name: "read_card" });
  await t.mutation(components.agevex.turns.tools.mark, { ...second, name: "write_card" });
  expect((await read(t, receipt.threadId))!.nodes[0].currentTool).toBe("write_card");
  await t.mutation(components.agevex.turns.tools.mark, second);
  expect((await read(t, receipt.threadId))!.nodes[0].currentTool).toBe("read_card");
  model.release();
  await drain(t);
  await t.mutation(components.agevex.turns.tools.mark, { ...first, name: "late" });

  expect((await read(t, receipt.threadId))!.nodes[0]).toMatchObject({
    status: "done",
    currentTool: null,
  });
});

it("explicit history remains scoped after later sends and foreign requests are refused", async () => {
  const { t } = setup();
  const receipt = await open(t, "first");

  await drain(t);
  const first = (await read(t, receipt.threadId))!;
  const later = gate();

  v2.steps.Main = async () => {
    await later.promise;

    return text("second");
  };

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "second",
    requestKey: "second",
  });

  await waitFor(t, async () => (await read(t, receipt.threadId))!.nodes[0].status === "running");
  expect((await read(t, receipt.threadId))!.rootRunId).not.toBe(first.rootRunId);
  expect(await read(t, receipt.threadId, first.rootRunId)).toEqual(first);
  const foreign = await open(t, "foreign");
  const other = (await read(t, foreign.threadId))!;

  await expect(read(t, receipt.threadId, other.rootRunId)).rejects.toThrow("FORBIDDEN");

  await expect(
    t
      .withIdentity({ subject: "mallory" })
      .query(api.agents.runTree, { threadId: receipt.threadId, rootRunId: first.rootRunId }),
  ).rejects.toThrow("FORBIDDEN");

  await expect(read(t, receipt.threadId, "invalid")).rejects.toThrow("FORBIDDEN");
  later.release();
  await drain(t);
});

it("cancellation fences an older request with a terminal pending delivery after a later send", async () => {
  const { t } = setup();
  const receipt = await open(t);

  await t.mutation(fixture.lifecycle, { assignmentId: receipt.assignmentId, block: "delivery" });
  const first = (await read(t, receipt.threadId))!;

  expect(first.nodes[0]).toMatchObject({ status: "asleep", reason: "children" });

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "later",
    requestKey: "later",
  });

  expect((await read(t, receipt.threadId))!.rootRunId).not.toBe(first.rootRunId);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

  expect((await read(t, receipt.threadId, first.rootRunId))!.nodes[0]).toMatchObject({
    status: "failed",
    reason: "cancelled",
    currentTool: null,
  });

  await drain(t);
});

it.each(["delivery", "group", "ready"] as const)(
  "an ended root remains open behind its %s fence",
  async (block) => {
    const { t } = setup();
    const receipt = await open(t);

    await t.mutation(fixture.lifecycle, { assignmentId: receipt.assignmentId, block });
    const fenced = (await read(t, receipt.threadId))!.nodes[0];

    expect(fenced.status).not.toBe("done");
    expect(fenced.finishedAt).toBeNull();
    await t.mutation(fixture.lifecycle, { assignmentId: receipt.assignmentId, block: "clear" });
    expect((await read(t, receipt.threadId))!.nodes[0]).toMatchObject({ status: "done" });
  },
);

it("an owned thread without a request returns null", async () => {
  const { t } = setup();

  await t.mutation(fixture.emptyRoot, {});
  expect(await read(t, "empty")).toBeNull();
});

it.each(["start", "clear", "both"])(
  "a throwing %s marker preserves the committed paid result and delivers it once",
  async (failure) => {
    const edges: string[] = [];

    const { t } = setup({
      marker: async ({ name }) => {
        const edge = name ? "start" : "clear";

        edges.push(edge);

        if (failure === edge || failure === "both") throw new Error("marker unavailable");
      },
    });

    v2.steps.Main = (n) => (n === 0 ? [call("write_card", { label: "paid" })] : text("done"));
    const receipt = await open(t);

    await drain(t);

    const results = v2.calls
      .flatMap(({ args }) => args.prompt)
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .filter((p) => p.type === "tool-result" && p.toolName === "write_card");

    expect(edges).toEqual(["start", "clear"]);
    expect(progress.started).toEqual(["paid"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ output: { type: "text", value: "written" } });

    expect((await read(t, receipt.threadId))!.nodes[0]).toMatchObject({
      status: "done",
      currentTool: null,
    });

    expect(
      (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!.activeTools,
    ).toBeUndefined();
  },
);

it("cancelling a done root preserves its recorded outcome and time on repeated cancel", async () => {
  const { t } = setup();
  const receipt = await open(t);

  await drain(t);
  const done = (await read(t, receipt.threadId))!.nodes[0];

  expect(done.status).toBe("done");
  expect(done.finishedAt).not.toBeNull();

  for (let i = 0; i < 2; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
    expect((await read(t, receipt.threadId))!.nodes[0]).toEqual(done);
  }

  await drain(t);
});

it.each([false, true])(
  "admitted run envelopes reserve lifecycle growth (failed=%s)",
  async (failed) => {
    const { t } = setup();

    await expect(
      t.mutation(fixture.envelopeLifecycle, { bytes: RUN_LIMITS.metadataBytes - 256, failed }),
    ).rejects.toThrow("RUN_METADATA_TOO_LARGE");

    const boundary = await t.mutation(fixture.envelopeLifecycle, {
      bytes: RUN_LIMITS.metadataBytes - RUN_LIMITS.nativeEnvelopeBytes,
      failed,
    });

    expect(boundary.bytes).toBeLessThanOrEqual(RUN_LIMITS.metadataBytes);
  },
);

it("exclusive meter usage sums to request totals including root background charges", async () => {
  const { t, meter } = setup({ meter: true });

  v2.steps.Main = (n) => (n === 0 ? [delegate("Builder")] : text("done"));
  const receipt = await open(t);

  await drain(t);
  const tree = (await read(t, receipt.threadId))!;

  for (const node of tree.nodes)
    await t.action(async (ctx) => {
      await meter
        .scope(ctx, {
          subject: "alice",
          rootThreadId: receipt.threadId,
          threadId: node.messages.threadId,
          runId: tree.rootRunId,
          agent: node.agent,
          nodeId: node.parentId === null ? undefined : node.id,
          purpose: node.parentId === null ? "summary" : "agent",
        })
        .record("fake", { key: node.id, usage: { inputTokens: 3, outputTokens: 7 } });
    });

  const measured = (await read(t, receipt.threadId))!;

  for (const metric of [
    "inputTokens",
    "outputTokens",
    "estimatedUsd",
    "settledUsd",
    "unknown",
  ] as const)
    expect(measured.nodes.reduce((sum, node) => sum + (node.usage![metric] ?? 0), 0)).toBeCloseTo(
      measured.usage![metric] ?? 0,
    );

  expect(measured.usage!.settledUsd).toBeGreaterThanOrEqual(0.02);
  await t.mutation(components.agevex.turns.slices.usageFailed, { runId: tree.rootRunId });
  expect((await read(t, receipt.threadId))!.usage!.reporting).toBe("partial");
});

it("all hard-maximum assignment and child envelopes plus meter stay below 8 MiB and 128 KiB output", async () => {
  const { t } = setup({
    meter: true,
    limits: Object.fromEntries(Object.entries(HOST_LIMITS).map(([key, value]) => [key, value.max])),
  });

  const root = await t.mutation(fixture.seedMaximum, {});
  const sizes = await t.query(fixture.maximumSizes, { rootRunId: root.rootRunId });

  expect(sizes.assignments).toEqual(
    Array(1 + TREE_LIMITS.descendants).fill(LIMITS.assignmentBytes),
  );

  expect(sizes.children).toEqual(Array(TREE_LIMITS.descendants).fill(4 << 10));

  await seedUsage(t, "alice", root.rootRunId, [
    null,
    ...Array.from({ length: TREE_LIMITS.descendants }, (_, i) => `node-${i}`),
  ]);

  const tree = (await read(t, root.threadId))!;

  expect(tree.nodes).toHaveLength(1 + TREE_LIMITS.descendants);

  expect(new TextEncoder().encode(JSON.stringify(tree)).length).toBeLessThanOrEqual(
    TREE_LIMITS.outputBytes,
  );

  expect(tree.nodes.every((node) => node.status === "done")).toBe(true);
});
