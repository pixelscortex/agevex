// @vitest-environment edge-runtime
import { sliceWatchdogMs, resolveRunSettings } from "../src/component/run_settings.js";
import { requireReceipt } from "./receipt.js";
import { it, expect, vi, afterEach, beforeEach } from "vite-plus/test";
import { setup, api, components, state } from "./setup.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const drain = (t: ReturnType<typeof setup>) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 2000);

// A healthy generation stays inside the 90s provider deadline. This fixture
// lowers tool time to 1s, deriving a 136s watchdog: only queue time exceeds it.
const GENERATION_MS = 60_000;

const open = (alice: ReturnType<ReturnType<typeof setup>["withIdentity"]>, prompt: string) =>
  alice
    .mutation(api.agents.open, { agent: "Main", prompt, requestKey: prompt })
    .then(requireReceipt);

// Seventeen real Workflow turns can exceed the default five-second wall clock
// on concurrent worktrees. The execution-window guarantee below uses fake time
// and exact call counts, so a longer harness timeout cannot weaken it.
it("a backlog larger than pool capacity runs every turn exactly once", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });

  state.run = { toolTimeoutMs: 1_000 };
  state.delayMs = GENERATION_MS;
  const receipts = [];

  for (let i = 0; i < 17; i++) receipts.push(await open(alice, `turn ${i}`));

  // Phase 1a has two root slots, so the last turn waits eight generations
  // (480s) of queue time for a slot: queue time must never count as execution time.
  await drain(t);

  expect(state.calls).toHaveLength(17);
  expect(new Set(state.calls.map((call) => JSON.stringify(call.prompt))).size).toBe(17);

  for (const receipt of receipts) {
    expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
      turnStatus: "idle",
      queuedMessages: 0,
      errorCode: null,
      assignmentStatus: "open",
    });
  }
}, 15_000);

it("an expired watchdog timer cannot strand a turn that is still queued", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await open(alice, "queued survivor");

  // `stalled` is internal to the queue component, so the test addresses it by
  // path, the way a leftover scheduled timer would.
  const watchdog = (components.agevex.turns.failures as Record<string, unknown>)
    .stalled as Parameters<typeof t.mutation>[0];

  await t.mutation(watchdog, {
    assignmentId: receipt.assignmentId,
    turnToken: `${receipt.assignmentId}:0`,
  });

  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "queued",
    errorCode: null,
  });

  await drain(t);
  expect(state.calls).toHaveLength(1);

  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "idle",
    queuedMessages: 0,
    errorCode: null,
    assignmentStatus: "open",
  });
});

it("a claimed turn keeps the full execution window", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await open(alice, "slow owner");
  const args = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:0` };

  expect(await t.mutation(components.agevex.turns.slices.claim, args)).not.toBeNull();

  await vi.advanceTimersByTimeAsync(sliceWatchdogMs(resolveRunSettings()) - 1_000);

  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "running",
    errorCode: null,
  });

  await vi.advanceTimersByTimeAsync(2_000);

  expect(await alice.query(api.agents.activity, { threadId: receipt.threadId })).toMatchObject({
    turnStatus: "recovery_required",
    errorCode: "EXECUTION_AMBIGUOUS",
  });

  // The watchdog only detects: it never takes the turn over or replays it.
  expect(state.calls).toHaveLength(0);
  expect(await t.mutation(components.agevex.turns.slices.claim, args)).toBeNull();
});
