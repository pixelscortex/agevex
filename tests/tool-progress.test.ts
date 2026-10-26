/** Progress RPCs cannot delay or replace tool results, stream values or failures. */
import { expect, it, vi } from "vite-plus/test";
import { tool } from "ai";
import { z } from "zod";
import { withToolProgress } from "../src/client/turn/tools.js";
import type { Generation } from "../src/client/turn/context.js";
import type { RuntimeContext } from "../src/client/registration/context.js";
import { gate } from "./message-parent.fixture.js";

function wrap(
  runMutation: (ref: unknown, args: { name?: string }) => Promise<null>,
  execute: () => unknown,
) {
  const rt = { component: { turns: { tools: { mark: "marker" } } } } as unknown as RuntimeContext;

  const gen = {
    turn: { rawCtx: { runMutation }, args: {}, turnKey: "slice" },
  } as unknown as Generation;

  const wrapped = withToolProgress(rt, gen, "effect", tool({ inputSchema: z.object({}), execute }));

  return () => wrapped.execute!({}, { toolCallId: "call", messages: [], context: {} });
}

it.each(["start", "clear"])(
  "a stalled %s marker never delays a successful tool result",
  async (edge) => {
    const held = gate();
    const clear = gate();

    const marker = vi.fn(async (_ref: unknown, args: { name?: string }) => {
      if ((args.name ? "start" : "clear") === edge) {
        clear.release();
        await held.promise;
      }

      return null;
    });

    const effect = vi.fn(() => "known result");
    const execute = wrap(marker, effect);

    try {
      expect(await execute()).toBe("known result");
      await clear.promise;
      expect(effect).toHaveBeenCalledTimes(1);
      expect(marker).toHaveBeenCalledTimes(edge === "start" ? 1 : 2);
    } finally {
      held.release();
    }
  },
);

it("clear follows a delayed start and leaves no resurrected progress", async () => {
  const held = gate();
  const cleared = gate();
  let active = false;

  const execute = wrap(
    async (_ref, args) => {
      if ((args as { name?: string }).name) {
        await held.promise;
        active = true;
      } else {
        active = false;
        cleared.release();
      }

      return null;
    },
    () => "result",
  );

  expect(await execute()).toBe("result");
  held.release();
  await cleared.promise;
  expect(active).toBe(false);
});

it.each(["exhaust", "return", "throw"])(
  "throwing markers preserve stream %s and cleanup",
  async (ending) => {
    const cleaned = vi.fn();
    const failure = new Error("tool failed");

    const marker = vi.fn(async (_ref: unknown, args: { name?: string }) => {
      if (!args.name) throw new Error("marker failed");

      return null;
    });

    const execute = wrap(marker, () =>
      (async function* () {
        try {
          yield "known result";

          if (ending === "throw") throw failure;
        } finally {
          cleaned();
        }
      })(),
    );

    const output = (await execute()) as AsyncIterableIterator<string>;

    expect(await output.next()).toEqual({ done: false, value: "known result" });

    if (ending === "throw") await expect(output.next()).rejects.toBe(failure);
    else
      expect(await (ending === "return" ? output.return!() : output.next())).toMatchObject({
        done: true,
      });

    expect(cleaned).toHaveBeenCalledTimes(1);
    await expect.poll(() => marker.mock.calls.length).toBe(2);
  },
);
