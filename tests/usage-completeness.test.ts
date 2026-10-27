// @vitest-environment edge-runtime
// Real Agent + agevex components, with provider-only failures and host OCC faults.
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { fixture, reset, exports, api, call, text } from "./hooks.host.js";
import { components } from "./fixture/api.js";
import { requireReceipt } from "./receipt.js";
import { LIMITS } from "../src/component/limits.js";
import { RUN_LIMITS, sliceDeadlineMs, resolveRunSettings } from "../src/component/run_settings.js";
import type { UsageEvent } from "../src/client/slots.js";
import * as generation from "../src/client/turn/generation.js";
import { opaqueKey } from "../src/client/keys.js";
import type { MessageDoc } from "@convex-dev/agent";

const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

function setup() {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: { ...modules, "./fixture/agents.ts": async () => exports() },
  });

  agent.register(t);
  agevex.register(t);

  return t;
}
type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });

const open = async (t: Test) =>
  requireReceipt(
    await owner(t).mutation(api.agents.open, {
      agent: "Main",
      prompt: "hello",
      requestKey: "usage",
    }),
  );

const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
const activity = (t: Test, threadId: string) => owner(t).query(api.agents.activity, { threadId });

async function partial(t: Test, threadId: string) {
  const runId = (await activity(t, threadId)).runId!;

  return t.query(components.agevex.turns.slices.usageReporting, { runId });
}
const events: UsageEvent[] = [];

beforeEach(() => {
  reset();
  events.length = 0;

  fixture.slots.usage = {
    record: async (_ctx, event) => {
      events.push(event);
    },
  };

  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["generate", "stream"] as const)(
  "an approval pause in %s retries a transient usage failure and keeps reporting complete",
  async (mode) => {
    fixture.run.Main = { mode };
    fixture.approval = true;
    fixture.steps.Main = () => call("echo", { text: "approval" });
    let attempts = 0;

    fixture.slots.usage = {
      record: async (_ctx, event) => {
        attempts++;

        if (attempts === 1) {
          // Cross a cancellation poll while the native approval save has cleared
          // its execution token. A legitimate pause must survive that poll too.
          await t.action(async () => {
            await vi.advanceTimersByTimeAsync(LIMITS.cancelPollMs);
          });

          throw new Error("transient");
        }

        events.push(event);
      },
    };

    const t = setup();
    const receipt = await open(t);

    await drain(t);
    expect(attempts).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("success");
    expect(await partial(t, receipt.threadId)).toBe(false);
    expect(fixture.calls).toHaveLength(1);
  },
);

it("cancellation during an approval-pause delivery revokes its retry allowance", async () => {
  fixture.approval = true;
  fixture.steps.Main = () => call("echo", { text: "approval" });
  let attempts = 0;

  fixture.slots.usage = {
    record: async (_ctx, event) => {
      attempts++;
      await owner(t).mutation(api.agents.cancel, { threadId: event.threadId });
      throw new Error("cancelled pause");
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(attempts).toBe(1);
  expect(events).toHaveLength(0);
  expect(await partial(t, receipt.threadId)).toBe(true);
});

/** Delay only the action's RPC reply, AFTER the real nested transaction commits. */
function holdSaveReply(mode: "late" | "drop" | "pending" | "unreadable" = "late") {
  let committed: MessageDoc | undefined;
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const original = generation.generateTurn;

  vi.spyOn(generation, "generateTurn").mockImplementation(async (rt, turn) => {
    const raw = turn.rawCtx;

    turn.rawCtx = {
      ...raw,
      runMutation: (async (ref, args) => {
        const isCompletion =
          args && "args" in args && args.args?.messages?.some((m: { usage?: unknown }) => m.usage);

        if (isCompletion && mode === "drop") throw new Error("save rolled back");

        if (isCompletion && mode === "pending") await gate;

        const result = await raw.runMutation(ref, args);

        if (isCompletion) {
          committed = (result as { messages: MessageDoc[] }).messages.find((m) => m.usage);
          await gate;
        }

        return result;
      }) as typeof raw.runMutation,
      runQuery: (async (ref, args) => {
        if (mode === "unreadable" && args && "messageIds" in args) await gate;

        return raw.runQuery(ref, args);
      }) as typeof raw.runQuery,
    };

    return original(rt, turn);
  });

  return { committed: () => committed, release: () => release() };
}

it.each(["generate", "stream"] as const)(
  "a committed %s save keeps its native message and legacy key when its reply misses the deadline",
  async (mode) => {
    fixture.run.Main = { mode, modelTimeoutMs: 1_000, toolTimeoutMs: 1_000 };
    const held = holdSaveReply();
    const t = setup();
    const receipt = await open(t);

    try {
      await waitFor(t, () => !!held.committed());
      expect(events).toHaveLength(0);

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(sliceDeadlineMs(resolveRunSettings(fixture.run.Main)));
      });

      await waitFor(t, () => events.length === 1);
      const native = held.committed()!;

      expect(events[0]).toMatchObject({ messageId: native._id, status: "aborted" });

      expect(events[0].key).toBe(
        await opaqueKey("model", receipt.threadId, native._id, native.stepOrder),
      );

      expect(await partial(t, receipt.threadId)).toBe(false);
    } finally {
      held.release();

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await drain(t);
    }

    expect(events).toHaveLength(1);
    expect(fixture.calls).toHaveLength(1);
  },
);

it.each(["generate", "stream"] as const)(
  "a %s completion save that rolls back reports null instead of its placeholder id",
  async (mode) => {
    fixture.run.Main = { mode };
    holdSaveReply("drop");
    const t = setup();
    const receipt = await open(t);

    await drain(t);
    expect(events).toHaveLength(1);
    expect(events[0].messageId).toBeNull();
    expect(await partial(t, receipt.threadId)).toBe(false);
    expect(fixture.calls).toHaveLength(1);
  },
);

it.each(["pending", "unreadable"] as const)(
  "an %s save outcome marks reporting partial within the evidence bound without choosing a false key",
  async (mode) => {
    fixture.run.Main = { modelTimeoutMs: 1_000, toolTimeoutMs: 1_000 };
    const held = holdSaveReply(mode);
    const t = setup();
    const receipt = await open(t);

    try {
      if (mode === "unreadable") await waitFor(t, () => !!held.committed());
      else await waitFor(t, () => fixture.calls.length === 1);

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(sliceDeadlineMs(resolveRunSettings(fixture.run.Main)));
        await vi.advanceTimersByTimeAsync(LIMITS.usageRecordTimeoutMs);
      });

      expect(await partial(t, receipt.threadId)).toBe(true);
      expect(events).toHaveLength(0);
    } finally {
      held.release();

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await drain(t);
    }

    expect(events).toHaveLength(0);
    expect(fixture.calls).toHaveLength(1);
  },
);

it.each(["cancel", "deadline"] as const)(
  "a stalled retry ownership read releases immediately on %s",
  async (stop) => {
    fixture.run.Main = { modelTimeoutMs: 1_000, toolTimeoutMs: 1_000 };
    let attempts = 0;
    let reading = false;
    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const original = generation.generateTurn;

    fixture.slots.usage = {
      record: async () => {
        attempts++;
        throw new Error("transient");
      },
    };

    vi.spyOn(generation, "generateTurn").mockImplementation(async (rt, turn) => {
      const raw = turn.rawCtx;

      turn.rawCtx = {
        ...raw,
        runQuery: (async (ref, args) => {
          if (attempts === 1 && !reading) {
            reading = true;
            await gate;
          }

          return raw.runQuery(ref, args);
        }) as typeof raw.runQuery,
      };

      return original(rt, turn);
    });

    const t = setup();
    const receipt = await open(t);

    try {
      await waitFor(t, () => reading);

      if (stop === "cancel")
        await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(
          stop === "cancel"
            ? LIMITS.cancelPollMs
            : sliceDeadlineMs(resolveRunSettings(fixture.run.Main)),
        );
      });

      // The stalled query is still pending; only the fence can release delivery.
      expect(await partial(t, receipt.threadId)).toBe(true);
      expect(attempts).toBe(1);
    } finally {
      release();

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await drain(t);
    }
  },
);

it.each(["generate", "stream"] as const)(
  "a paid %s step that fails reports provider usage once with failed status",
  async (mode) => {
    fixture.run.Main = { mode };

    fixture.providerGenerate = (result) => ({
      ...result,
      finishReason: { unified: "error", raw: "error" },
    });

    fixture.providerStream = (stream) =>
      stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(part);

            // Usage has arrived; the provider then terminates unsuccessfully.
            if (part.type === "finish")
              controller.enqueue({ type: "error", error: new Error("paid stream failed") });
          },
        }),
      );

    const t = setup();
    const receipt = await open(t);

    await drain(t);
    expect((await activity(t, receipt.threadId)).errorCode).toBe("GENERATION_FAILED");
    expect(events).toHaveLength(1);

    expect(events[0]).toMatchObject({
      status: "failed",
      usage: { promptTokens: 3, completionTokens: 10 },
    });

    expect(fixture.calls).toHaveLength(1);
    expect(await partial(t, receipt.threadId)).toBe(false);
  },
);

/** Hold the provider stream open AFTER its finish/usage event was consumed,
 * before Agent's onStepFinish can save. Cancellation must drop that save. */
function holdAfterUsage() {
  let reported = false;
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  fixture.providerStream = (stream) =>
    stream.pipeThrough(
      new TransformStream({
        transform(part, controller) {
          controller.enqueue(part);
        },
        async flush() {
          reported = true;
          await gate;
        },
      }),
    );

  return { reported: () => reported, release: () => release() };
}
async function waitFor(t: Test, check: () => boolean) {
  await expect
    .poll(async () => {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      return check();
    })
    .toBe(true);
}

/** The review probe's metadata/text/error sequence, held before finish for
 * cancellation and timeout. A late close must not manufacture token evidence. */
function interruptBeforeFinish(
  hold: boolean,
  metadata = true,
  transport = false,
  id = true,
  fence = false,
) {
  let reached = false;
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  fixture.providerStream = (stream) =>
    stream.pipeThrough(
      new TransformStream({
        start(controller) {
          if (metadata)
            controller.enqueue({
              type: "response-metadata",
              ...(id ? { id: "gen-offline-billed" } : {}),
              modelId: "provider-model",
            });
        },
        async transform(part, controller) {
          if (part.type !== "finish") {
            controller.enqueue(part);

            return;
          }

          reached = true;

          if (hold) await gate;

          if (transport) throw new Error("stream transport failed");

          // A provider exceeding the admitted tool-call cap revokes the slice
          // before finish, independently of the cancellation poll or deadline.
          if (fence)
            for (let n = 0; n <= RUN_LIMITS.toolsPerSlice; n++) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `fenced-${n}`,
                toolName: "managed",
                input: "{}",
              });
            }

          controller.enqueue({ type: "error", error: new Error("connection lost before finish") });
        },
      }),
    );

  return { reached: () => reached, release: () => release() };
}

it.each(["error", "transport", "timeout", "cancel", "fence"] as const)(
  "metadata and text followed by %s reports one failed/aborted event with requestId and unknown usage",
  async (stop) => {
    fixture.run.Main = { modelTimeoutMs: 1_000, toolTimeoutMs: 1_000 };
    const aborted = stop === "timeout" || stop === "cancel" || stop === "fence";

    const held = interruptBeforeFinish(
      stop === "timeout" || stop === "cancel",
      true,
      stop === "transport",
      true,
      stop === "fence",
    );

    const t = setup();
    const receipt = await open(t);
    const before = Date.now();

    try {
      await waitFor(t, held.reached);

      if (stop === "cancel")
        await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

      if (aborted)
        await t.action(async () => {
          await vi.advanceTimersByTimeAsync(stop === "timeout" ? 1_001 : LIMITS.cancelPollMs);
        });

      await waitFor(t, () => events.length === 1);

      expect(events[0]).toMatchObject({
        requestId: "gen-offline-billed",
        model: "provider-model",
        status: aborted ? "aborted" : "failed",
        messageId: null,
      });

      expect(events[0].usage).toBeUndefined();
      expect(events[0]).not.toHaveProperty("usage");
      expect(events[0].occurredAt).toBeGreaterThanOrEqual(before);
      expect(events[0].key).toHaveLength(64);
    } finally {
      held.release();

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await drain(t);
    }

    expect(events).toHaveLength(1);
    expect(fixture.calls).toHaveLength(1);
    expect(await partial(t, receipt.threadId)).toBe(false);
  },
);

it("response metadata without an id still reports one interrupted attempt with unknown usage", async () => {
  interruptBeforeFinish(false, true, false, false);
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ status: "failed", model: "provider-model" });
  expect(events[0].requestId).toBeUndefined();
  expect(events[0].usage).toBeUndefined();
  expect(await partial(t, receipt.threadId)).toBe(false);
});

it("pre-finish evidence retries the same key and timestamp without rerunning the model", async () => {
  interruptBeforeFinish(false);
  const attempts: UsageEvent[] = [];

  fixture.slots.usage = {
    record: async (_ctx, event) => {
      attempts.push(event);

      if (attempts.length < LIMITS.usageRecordAttempts) throw new Error("transient");

      events.push(event);
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(attempts).toHaveLength(LIMITS.usageRecordAttempts);
  expect(attempts.every((event) => event === attempts[0])).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0].requestId).toBe("gen-offline-billed");
  expect(events[0].usage).toBeUndefined();
  expect(fixture.calls).toHaveLength(1);
  expect(await partial(t, receipt.threadId)).toBe(false);
});

it("a stream error without response metadata emits no event or invented tokens", async () => {
  interruptBeforeFinish(false, false);
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(events).toHaveLength(0);
  expect(await partial(t, receipt.threadId)).toBe(true);
  expect(fixture.calls).toHaveLength(1);
});

it("response metadata followed by finish enriches one event with usage and the native key", async () => {
  fixture.generationIds = true;
  const t = setup();

  await open(t);
  await drain(t);
  expect(events).toHaveLength(1);

  expect(events[0]).toMatchObject({
    status: "success",
    requestId: "generation:Main:1",
    usage: { promptTokens: 3, completionTokens: 10 },
  });

  expect(events[0].messageId).toBeTruthy();

  const [saved] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [events[0].messageId!],
  });

  expect(events[0].key).toBe(
    await opaqueKey("model", events[0].threadId, events[0].messageId!, saved!.stepOrder),
  );
});

it.each(["cancel", "timeout"] as const)(
  "a %s after stream usage reports the aborted step once with null messageId",
  async (stop) => {
    fixture.run.Main = { modelTimeoutMs: 1_000, toolTimeoutMs: 1_000 };
    const held = holdAfterUsage();
    const t = setup();
    const receipt = await open(t);

    try {
      await waitFor(t, held.reported);

      if (stop === "cancel")
        await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(
          stop === "cancel"
            ? LIMITS.cancelPollMs
            : sliceDeadlineMs(resolveRunSettings(fixture.run.Main)),
        );
      });

      await waitFor(t, () => events.length === 1);

      expect(events[0]).toMatchObject({
        status: "aborted",
        messageId: null,
        usage: { promptTokens: 3, completionTokens: 10 },
      });

      if (stop === "timeout")
        expect((await activity(t, receipt.threadId)).errorCode).toBe("RUN_TIMEOUT");
    } finally {
      held.release();

      await t.action(async () => {
        // Drain the late native promise while convex-test still owns its context.
        await vi.advanceTimersByTimeAsync(0);
      });

      await drain(t);
    }

    expect(events).toHaveLength(1);
    expect(fixture.calls).toHaveLength(1);
    expect(await partial(t, receipt.threadId)).toBe(false);
  },
);

it("two transient hook failures retry the same event and key, record once, and keep reporting complete", async () => {
  const attempts: UsageEvent[] = [];

  fixture.slots.usage = {
    record: async (_ctx, event) => {
      attempts.push({ ...event });

      if (attempts.length < 3) throw new Error("OCC conflict");

      events.push(event);
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(attempts).toHaveLength(3);

  expect(
    attempts.every(
      (event) => event.key === attempts[0].key && event.occurredAt === attempts[0].occurredAt,
    ),
  ).toBe(true);

  expect(events).toHaveLength(1);
  expect(await partial(t, receipt.threadId)).toBe(false);
  expect(fixture.calls).toHaveLength(1);
});

it("persistent hook failure exhausts the bounded attempts then marks partial without rerunning the model", async () => {
  const attempts: UsageEvent[] = [];

  fixture.slots.usage = {
    record: async (_ctx, event) => {
      attempts.push(event);
      throw new Error("unavailable");
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(attempts).toHaveLength(LIMITS.usageRecordAttempts);
  expect(new Set(attempts.map((event) => event.key)).size).toBe(1);
  expect(await partial(t, receipt.threadId)).toBe(true);
  expect(fixture.calls).toHaveLength(1);
  expect((await activity(t, receipt.threadId)).errorCode).toBeNull();
});

it("a hook that never settles times out with bounded attempts and never repeats the paid model", async () => {
  const attempts: UsageEvent[] = [];

  fixture.slots.usage = {
    record: async (_ctx, event) => {
      attempts.push(event);
      await new Promise<void>(() => {});
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts.map((event) => event.key)).size).toBe(1);
  expect(await partial(t, receipt.threadId)).toBe(true);
  expect(fixture.calls).toHaveLength(1);
  expect((await activity(t, receipt.threadId)).errorCode).toBeNull();
});

it("cancellation during a failing hook prevents further delivery attempts", async () => {
  let attempts = 0;

  fixture.slots.usage = {
    record: async (_ctx, event) => {
      attempts++;
      await owner(t).mutation(api.agents.cancel, { threadId: event.threadId });
      throw new Error("cancelled during delivery");
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(attempts).toBe(1);
  expect(await partial(t, receipt.threadId)).toBe(true);
  expect(fixture.calls).toHaveLength(1);
});

it.each(["generate", "stream"] as const)(
  "a successful %s step reports once with its finish timestamp and exact saved message",
  async (mode) => {
    fixture.run.Main = { mode };
    const t = setup();
    const receipt = await open(t);
    const before = Date.now();

    await drain(t);
    expect(events).toHaveLength(1);
    const event = events[0];

    expect(event.status).toBe("success");
    expect(Number.isSafeInteger(event.occurredAt)).toBe(true);
    expect(event.occurredAt).toBeGreaterThanOrEqual(before);
    expect(event.occurredAt).toBeLessThanOrEqual(Date.now());
    expect(event.messageId).toBeTruthy();

    const [saved] = await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [event.messageId!],
    });

    expect(event.usage).toEqual(saved!.usage);
    expect(await partial(t, receipt.threadId)).toBe(false);
    expect(fixture.calls).toHaveLength(1);
  },
);

it("a later step without provider usage emits no fabricated charge beside the one completed step", async () => {
  fixture.steps.Main = (n) => {
    if (n === 0) return call("managed", {});

    throw new Error("no provider usage");
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ status: "success" });
  expect(await partial(t, receipt.threadId)).toBe(true);
  expect(fixture.calls).toHaveLength(2);
});

it("transient delivery retries finish before a tool step can continue or admit another model", async () => {
  fixture.steps.Main = (n) => (n === 0 ? call("managed", {}) : text("done"));
  let attempts = 0;

  fixture.slots.usage = {
    record: async (_ctx, event) => {
      attempts++;

      if (attempts < 3) throw new Error("OCC conflict");

      if (events.length === 0) expect(fixture.calls).toHaveLength(1);

      events.push(event);
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(events).toHaveLength(2);
  expect(attempts).toBe(4);
  expect(await partial(t, receipt.threadId)).toBe(false);
});

it("the turn deadline interrupts a pending delivery and prevents retries", async () => {
  fixture.run.Main = { modelTimeoutMs: 1_000, toolTimeoutMs: 1_000 };
  let attempts = 0;

  fixture.slots.usage = {
    record: async () => {
      attempts++;

      // Expire the live deadline before promise continuations can admit a retry.
      await t.action(async () => {
        vi.advanceTimersByTime(sliceDeadlineMs(resolveRunSettings(fixture.run.Main)));
      });

      throw new Error("deadline crossed");
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(attempts).toBe(1);
  expect(await partial(t, receipt.threadId)).toBe(true);
  expect(fixture.calls).toHaveLength(1);
});

it("occurredAt remains the provider finish time through a delayed save and delivery retries", async () => {
  const held = holdAfterUsage();
  let attempts = 0;

  fixture.slots.usage = {
    record: async (_ctx, event) => {
      attempts++;

      if (attempts < 3) throw new Error("transient");

      events.push(event);
    },
  };

  const t = setup();
  const receipt = await open(t);

  await waitFor(t, held.reported);
  const finishedBy = Date.now();

  await t.action(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });

  held.release();
  await drain(t);
  expect(events).toHaveLength(1);
  expect(events[0].occurredAt).toBeLessThanOrEqual(finishedBy);
  expect(events[0].occurredAt).toBeLessThan(Date.now());
  expect(events[0].messageId).toBeTruthy();
  expect(attempts).toBe(3);
  expect(await partial(t, receipt.threadId)).toBe(false);
});
