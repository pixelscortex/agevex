// @vitest-environment happy-dom
/** Native page boundaries must not split tool exchanges or blank live work. */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import type { UIMessage } from "@convex-dev/agent";
import { createAgevexHooks } from "../../src/react/index.js";
import { api, transport } from "./client.fixture.js";

afterEach(cleanup);
const hooks = createAgevexHooks(api);

function message(id: string, order: number, parts: UIMessage["parts"]): UIMessage {
  return {
    id,
    key: id,
    order,
    stepOrder: 0,
    role: "assistant",
    status: "success",
    parts,
    text: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" "),
    _creationTime: 0,
  };
}

it("tool calls and results on different native pages recombine with their origin annotations", () => {
  const call = {
    ...message("call", 2, [
      { type: "text", text: "Searching" },
      { type: "tool-search", toolCallId: "search", state: "input-available", input: { q: "card" } },
    ]),
    status: "pending",
    origin: "note",
    from: "Reviewer",
    runId: "review-run",
  };

  const result = {
    ...message("result", 2, [
      {
        type: "tool-search",
        toolCallId: "search",
        state: "output-available",
        input: undefined,
        output: "found",
      },
      { type: "text", text: "Done" },
    ]),
    stepOrder: 1,
  };

  const t = transport((name, args) =>
    name.endsWith(":streams")
      ? { streams: { kind: "list", messages: [] } }
      : (args.paginationOpts as { cursor: string | null }).cursor === null
        ? { page: [result], isDone: false, continueCursor: "older" }
        : { page: [call], isDone: true, continueCursor: "" },
  );

  const { result: state } = renderHook(() => hooks.useThread("thread"), { wrapper: t.wrapper });

  act(() => state.current.loadMore());
  expect(state.current.messages).toHaveLength(1);

  expect(state.current.messages[0]).toMatchObject({
    id: "call",
    status: "success",
    origin: "note",
    from: "Reviewer",
    runId: "review-run",
    text: "Searching Done",
  });

  expect(state.current.messages[0].parts).toEqual([
    { type: "text", text: "Searching" },
    {
      type: "tool-search",
      toolCallId: "search",
      state: "output-available",
      input: { q: "card" },
      output: "found",
    },
    { type: "text", text: "Done" },
  ]);
});

it("an uncached older page keeps loaded messages and live streams ready while loading more", async () => {
  const latest = message("latest", 2, [{ type: "text", text: "Stored" }]);
  const older = message("older", 1, [{ type: "text", text: "Older" }]);
  let resolve!: () => void;
  let loaded = false;

  const pending = new Promise<void>((done) => {
    resolve = done;
  });

  const t = transport((name, args) => {
    if (name.endsWith(":messages")) {
      if ((args.paginationOpts as { cursor: string | null }).cursor === null)
        return { page: [latest], isDone: false, continueCursor: "older" };

      return loaded ? { page: [older], isDone: true, continueCursor: "" } : undefined;
    }

    const stream = args.streamArgs as { kind: string; cursors?: { cursor: number }[] };

    return {
      streams:
        stream.kind === "list"
          ? {
              kind: "list",
              messages: [
                {
                  streamId: "live",
                  order: 3,
                  stepOrder: 0,
                  status: "streaming",
                  format: "UIMessageChunk",
                  providerOptions: {},
                },
              ],
            }
          : {
              kind: "deltas",
              deltas:
                stream.cursors?.[0].cursor === 0
                  ? [
                      {
                        streamId: "live",
                        start: 0,
                        end: 1,
                        parts: [
                          { type: "text-start", id: "text" },
                          { type: "text-delta", id: "text", delta: "Live" },
                        ],
                      },
                    ]
                  : [],
            },
    };
  });

  const delivery = pending.then(() => {
    loaded = true;
    t.update();
  });

  const { result } = renderHook(() => hooks.useThread("thread"), { wrapper: t.wrapper });

  await waitFor(() =>
    expect(result.current.messages.map((m) => m.text)).toEqual(["Stored", "Live"]),
  );

  act(() => result.current.loadMore());
  expect(result.current.status).toBe("ready");
  expect(result.current.messages.map((m) => m.text)).toEqual(["Stored", "Live"]);
  expect(result.current.data).toEqual(result.current.messages);
  expect(result.current.isLoadingMore).toBe(true);
  expect(result.current.canLoadMore).toBe(false);
  expect([...t.active.keys()].some((key) => key.includes("authorized:streams"))).toBe(true);

  await act(async () => {
    resolve();
    await delivery;
  });

  await waitFor(() =>
    expect(result.current.messages.map((m) => m.text)).toEqual(["Older", "Stored", "Live"]),
  );

  expect(result.current.isLoadingMore).toBe(false);
  expect(result.current.canLoadMore).toBe(false);
});
