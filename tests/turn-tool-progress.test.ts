/** A real runTurn action must own progress RPCs after the paid tool has finished. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { call, text, v2, v2api as api } from "./delegation-v2.host.js";
import { setup, open, drain, progress, gate, read } from "./run-tree.fixture.js";
import { waitFor } from "./message-parent.fixture.js";
import { rawAssignment } from "./fixture/api.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["start", "clear"])(
  "runTurn waits for a pending %s marker after the paid tool succeeds without changing its result",
  async (edge) => {
    const held = gate();
    const edges: string[] = [];
    let returned = false;

    const { t } = setup({
      turnReturned: () => {
        returned = true;
      },
      markerRpc: async ({ name }) => {
        const current = name ? "start" : "clear";

        edges.push(current);

        if (current === edge) {
          await held.promise;
        }
      },
    });

    v2.steps.Main = (n) => (n === 0 ? [call("write_card", { label: "paid" })] : text("done"));
    const receipt = await open(t);

    try {
      await waitFor(t, () => edges.includes(edge));

      await waitFor(t, async () => {
        const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

        return progress.started.length === 1 && row?.turnStatus === "running" && !row.watchdogId;
      });

      expect(returned).toBe(false);
      expect(progress.started).toEqual(["paid"]);
    } finally {
      held.release();
      await drain(t);
    }

    expect(returned).toBe(true);
    expect(edges).toEqual(["start", "clear"]);

    const results = v2.calls
      .flatMap(({ args }) => args.prompt)
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .filter((part) => part.type === "tool-result" && part.toolName === "write_card");

    expect(progress.started).toEqual(["paid"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ output: { type: "text", value: "written" } });

    expect((await read(t, receipt.threadId))!.nodes[0]).toMatchObject({
      status: "done",
      currentTool: null,
    });
  },
);

it("a fence-aborted action settles markers before returning and late paid completion dispatches no RPC", async () => {
  const held = gate();
  const effect = gate();
  const edges: string[] = [];
  let returned = false;

  const { t } = setup({
    turnReturned: () => {
      returned = true;
    },
    markerRpc: async ({ name }) => {
      edges.push(name ? "start" : "clear");

      if (name) await held.promise;
    },
  });

  progress.gates.set("paid", effect);
  v2.steps.Main = () => [call("write_card", { label: "paid" })];
  const receipt = await open(t);

  try {
    await waitFor(t, () => edges.length === 1 && progress.started.length === 1);

    await t
      .withIdentity({ subject: "alice" })
      .mutation(api.agents.cancel, { threadId: receipt.threadId });

    await waitFor(t, async () => {
      const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

      return row?.cancelled === true && row.turnToken === undefined;
    });

    expect(returned).toBe(false);
    held.release();
    await drain(t);
    expect(returned).toBe(true);
    expect(edges).toEqual(["start", "clear"]);

    expect((await read(t, receipt.threadId))!.nodes[0]).toMatchObject({
      status: "failed",
      reason: "cancelled",
      currentTool: null,
    });

    effect.release();

    await t.action(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(edges).toEqual(["start", "clear"]);
    expect(progress.started).toEqual(["paid"]);
  } finally {
    held.release();
    effect.release();
    await drain(t);
  }
});
