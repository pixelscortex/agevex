// @vitest-environment edge-runtime
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { setup, api, state } from "./setup.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("nested Workflow to host/native Agent bridge", () => {
  it("accepts, dispatches through a host function handle and streams a native transcript", async () => {
    vi.useFakeTimers();
    const t = setup();
    const alice = t.withIdentity({ subject: "alice" });
    const receipt = await alice.mutation(api.agents.open, {
      agent: "Main",
      prompt: "hello",
      requestKey: "one",
    });
    expect(receipt.status).toBe("accepted");
    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
    expect(state.calls).toHaveLength(1);
    const activity = await alice.query(api.agents.activity, { threadId: receipt.threadId });
    expect(activity).toMatchObject({
      assignmentStatus: "open",
      turnStatus: "idle",
      errorCode: null,
    });
    const messages = await alice.query(api.agents.messages, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 20 },
      streamArgs: { kind: "list" },
    });
    expect(messages.page.map((m) => m.text)).toContain("DEMO deterministic native reply");
    expect(messages.page.map((m) => m.text)).toContain("hello");
    expect(messages.streams).toMatchObject({ kind: "list" });
  });
});
