// @vitest-environment happy-dom
/** Public hook guarantees exercised with real React and Convex subscription glue. */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { createAgevexHooks } from "../../src/react/index.js";
import { api, transport } from "./client.fixture.js";

const hooks = createAgevexHooks(api);

afterEach(cleanup);

const pending = {
  id: "approval",
  toolCallId: "tool-call",
  threadId: "child",
  agent: "Builder",
  tool: "publish",
  kind: "approval" as const,
  input: { body: "old" },
  providerExecuted: false,
  editable: true,
};

function page(cursor: string | null) {
  const offset = cursor === null ? 0 : Number(cursor);

  return {
    page: Array.from({ length: 50 }, (_, i) => ({
      id: String(offset + i),
      key: String(offset + i),
      order: 1000 - offset - i,
      stepOrder: 0,
      origin: "user",
      role: "assistant",
      parts: [{ type: "text", text: String(offset + i) }],
      text: String(offset + i),
      status: "success",
      _creationTime: 0,
    })),
    isDone: false,
    continueCursor: String(offset + 50),
  };
}

it("skipped when id missing never subscribes or writes to a previous thread", async () => {
  const t = transport();

  const { result } = renderHook(
    () => ({
      thread: hooks.useThread(),
      tree: hooks.useRunTree(),
      approvals: hooks.usePendingApprovals(),
      ask: hooks.useAsk(),
      title: hooks.useTitle(),
      summary: hooks.useSummary(),
    }),
    { wrapper: t.wrapper },
  );

  for (const value of Object.values(result.current)) {
    expect(value.status).toBe("skipped");
    expect(value.data).toBeUndefined();
  }

  expect(t.watched).toEqual([]);
  await expect(result.current.thread.send("text")).rejects.toThrow("select a thread");
  expect(t.writes).toEqual([]);
});

it("thread switch clears old data on the first render including stream and metadata state", () => {
  const t = transport((name, args) => {
    if (args.threadId !== "old") return undefined;

    if (name.endsWith(":messages")) return page(null);

    if (name.endsWith(":streams")) return { streams: { kind: "list", messages: [] } };

    if (name.endsWith(":pendingApprovals")) return [pending];

    return { text: "old private data", source: "user", version: 1 };
  });

  const seen: unknown[] = [];

  const { result, rerender } = renderHook(
    ({ id }: { id?: string }) => {
      const state = {
        thread: hooks.useThread(id),
        title: hooks.useTitle(id),
        tree: hooks.useRunTree(id),
        pending: hooks.usePendingApprovals(id),
      };

      seen.push(state);

      return state;
    },
    { wrapper: t.wrapper, initialProps: { id: "old" as string | undefined } },
  );

  expect(result.current.thread.messages).toHaveLength(50);
  seen.length = 0;
  rerender({ id: "new" });
  expect(JSON.stringify(seen)).not.toContain("old private data");
  expect(result.current.thread.messages).toEqual([]);

  for (const state of Object.values(result.current)) expect(state.status).toBe("loading");

  rerender({ id: undefined });
  expect(result.current.thread).toMatchObject({ status: "skipped", messages: [] });
});

it("hooks use the app's authorized refs and auth errors surface unchanged", async () => {
  const forbidden = new ConvexError({ code: "FORBIDDEN" });
  const t = transport(() => forbidden);

  expect(() => renderHook(() => hooks.useTitle("private"), { wrapper: t.wrapper })).toThrow(
    forbidden,
  );

  expect(t.watched.every((watch) => watch.name === "authorized:title")).toBe(true);

  const writes = transport(() => [pending]);

  writes.mutate(async () => {
    throw forbidden;
  });

  const { result } = renderHook(() => hooks.usePendingApprovals("private"), {
    wrapper: writes.wrapper,
  });

  await expect(result.current.approve(pending)).rejects.toBe(forbidden);
});

it("messages stay windowed and evict subscriptions while loadLatest returns to live history", () => {
  const t = transport((name, args) =>
    name.endsWith(":messages")
      ? page((args.paginationOpts as { cursor: string | null }).cursor)
      : { streams: { kind: "list", messages: [] } },
  );

  const { result } = renderHook(() => hooks.useThread("thread"), { wrapper: t.wrapper });

  expect(result.current.messages).toHaveLength(50);
  expect(t.active.size).toBe(2);

  for (let i = 0; i < 15; i++) {
    act(() => result.current.loadMore());
    expect(result.current.messages.length).toBeLessThanOrEqual(500);

    expect(
      [...t.active.keys()].filter((key) => key.includes("authorized:messages")).length,
    ).toBeLessThanOrEqual(10);
  }

  expect(result.current.evicted).toBe(true);
  expect(result.current.messages.some((message) => message.id === "0")).toBe(false);
  act(() => result.current.loadLatest());
  expect(result.current.messages).toHaveLength(50);
  expect(result.current.messages.some((message) => message.id === "0")).toBe(true);
  expect(result.current.evicted).toBe(false);
});

it("approve waits for the server receipt and edit/reject address the pending child's authorized endpoint", async () => {
  const t = transport(() => [pending]);
  let finish!: (value: unknown) => void;

  t.mutate(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  const { result } = renderHook(() => hooks.usePendingApprovals("root"), { wrapper: t.wrapper });
  let received = false;

  const promise = result.current.approve(pending).then((receipt) => {
    received = true;

    return receipt;
  });

  await act(async () => {
    await Promise.resolve();
  });

  expect(received).toBe(false);
  expect(result.current.data).toEqual([pending]);

  expect(t.writes[0]).toMatchObject({
    name: "authorized:respond",
    args: { threadId: "child", approvalId: "approval", decision: { kind: "approve" } },
  });

  const receipt = { messageId: "committed", replayed: false };

  finish(receipt);
  expect(await promise).toEqual(receipt);
  t.mutate(async () => receipt);
  await result.current.edit(pending, { body: "changed" });
  await result.current.reject(pending, "reason");

  expect(t.writes[1].args.decision).toEqual({
    kind: "approve",
    edit: { input: { body: "changed" } },
  });

  expect(t.writes[2].args.decision).toEqual({ kind: "reject", reason: "reason" });
});

it("ask filters the shared pending query and answers with a structured value", async () => {
  const ask = {
    ...pending,
    id: "ask",
    kind: "ask" as const,
    question: "Which?",
    schema: { type: "object" },
  };

  const t = transport(() => [pending, ask]);
  const { result } = renderHook(() => hooks.useAsk("root"), { wrapper: t.wrapper });

  expect(result.current.data).toEqual([ask]);
  await result.current.answer(ask, { choice: "yes" });

  expect(t.writes[0]).toMatchObject({
    name: "authorized:answer",
    args: { threadId: "child", toolCallId: "tool-call", value: { choice: "yes" } },
  });
});

it("an app can retry a rejected send with the same intent key while fresh sends get new keys", async () => {
  const t = transport((name) =>
    name.endsWith(":messages")
      ? { page: [], isDone: true, continueCursor: "" }
      : { streams: { kind: "list", messages: [] } },
  );

  const disconnected = new Error("connection lost before receipt");
  let attempt = 0;

  t.mutate(async () => {
    if (attempt++ === 0) throw disconnected;

    return { status: "accepted" };
  });

  const { result } = renderHook(() => hooks.useThread("thread"), { wrapper: t.wrapper });

  // The app retains the intent, including its key, until it gets a receipt.
  const intent = { requestKey: crypto.randomUUID() };

  await expect(result.current.send("same text", intent)).rejects.toBe(disconnected);
  expect(t.writes).toHaveLength(1);
  await expect(result.current.send("same text", intent)).resolves.toEqual({ status: "accepted" });
  expect(t.writes).toHaveLength(2);
  expect(t.writes[0].args).toEqual(t.writes[1].args);
  expect(t.writes[1].args.requestKey).toBe(intent.requestKey);
  await result.current.send("same text");
  await result.current.send("same text");
  expect(t.writes[2].args.requestKey).not.toBe(intent.requestKey);
  expect(t.writes[2].args.requestKey).not.toBe(t.writes[3].args.requestKey);
});

it("title rename uses the observed version and runTree preserves the supplied reference's return type", async () => {
  const tree = makeFunctionReference<
    "query",
    { threadId: string; rootRunId?: string },
    { rootRunId: string; nodes: string[] } | null
  >("custom:tree");

  const custom = createAgevexHooks({ ...api, runTree: tree });

  const t = transport((name) =>
    name === "custom:tree"
      ? { rootRunId: "run", nodes: ["Main"] }
      : { text: "title", source: "user", version: 7 },
  );

  const { result } = renderHook(
    () => ({ title: custom.useTitle("thread"), tree: custom.useRunTree("thread", "run") }),
    { wrapper: t.wrapper },
  );

  const nodes: string[] | undefined = result.current.tree.data?.nodes;

  expect(nodes).toEqual(["Main"]);
  await result.current.title.rename("new title");
  expect(t.writes[0].args).toEqual({ threadId: "thread", text: "new title", expectedVersion: 7 });

  expect(
    t.watched.some((watch) => watch.name === "custom:tree" && watch.args.rootRunId === "run"),
  ).toBe(true);
});

it("missing refs fail only when the hook needing them is used", () => {
  const partial = createAgevexHooks({});
  const t = transport();

  expect(() => renderHook(() => partial.useTitle("thread"), { wrapper: t.wrapper })).toThrow(
    "authorized 'title' endpoint",
  );
});

it("native stream deltas become messages and disappear immediately on thread switch", async () => {
  const t = transport((name, args) => {
    if (args.threadId !== "old") return undefined;

    if (name.endsWith(":messages")) return { page: [], isDone: true, continueCursor: "" };

    const streamArgs = args.streamArgs as { kind: string; cursors?: { cursor: number }[] };

    return {
      streams:
        streamArgs.kind === "list"
          ? {
              kind: "list",
              messages: [
                {
                  streamId: "live",
                  order: 1,
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
                streamArgs.cursors?.[0].cursor === 0
                  ? [
                      {
                        streamId: "live",
                        start: 0,
                        end: 1,
                        parts: [
                          { type: "text-start", id: "text" },
                          { type: "text-delta", id: "text", delta: "private live text" },
                        ],
                      },
                    ]
                  : [],
            },
    };
  });

  const { result, rerender } = renderHook(({ id }) => hooks.useThread(id), {
    wrapper: t.wrapper,
    initialProps: { id: "old" },
  });

  await waitFor(() =>
    expect(JSON.stringify(result.current.messages)).toContain("private live text"),
  );

  expect(result.current.messages[0].status).toBe("streaming");
  rerender({ id: "new" });
  expect(result.current).toMatchObject({ status: "loading", messages: [] });
});

it("reactive page boundaries refresh already requested history without missing messages", () => {
  let shift = 0;

  const t = transport((name, args) => {
    if (name.endsWith(":streams")) return { streams: { kind: "list", messages: [] } };

    const cursor = (args.paginationOpts as { cursor: string | null }).cursor;

    return page(cursor === null ? String(-shift) : cursor);
  });

  const { result } = renderHook(() => hooks.useThread("thread"), { wrapper: t.wrapper });

  act(() => result.current.loadMore());
  expect(result.current.messages).toHaveLength(100);
  shift = 1;
  act(() => t.update());
  expect(result.current.messages).toHaveLength(100);
  expect(result.current.messages.some((message) => message.id === "49")).toBe(true);
  expect(result.current.messages.some((message) => message.id === "-1")).toBe(true);
});

it("generated public API proxies keep message subscriptions stable across renders", () => {
  const refs = new Proxy(
    {},
    { get: (_target, key) => makeFunctionReference(`authorized:${String(key)}`) },
  ) as typeof api;

  const dynamic = createAgevexHooks(refs);

  const t = transport((name) =>
    name.endsWith(":messages") ? page(null) : { streams: { kind: "list", messages: [] } },
  );

  const { result, rerender } = renderHook(() => dynamic.useThread("thread"), {
    wrapper: t.wrapper,
  });

  expect(result.current.messages).toHaveLength(50);
  rerender();
  expect(result.current.messages).toHaveLength(50);
  expect(t.active.size).toBe(2);
});
