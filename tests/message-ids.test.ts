// @vitest-environment edge-runtime
/** Public hook/tool message identities follow native saves and slice fences. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { MessageDoc } from "@convex-dev/agent";
import type { ToolContext } from "../src/client/index.js";
import { getConvexSize } from "convex/values";
import { HOST_LIMITS, LIMITS } from "../src/component/limits.js";
import { RUN_LIMITS } from "../src/component/run-settings.js";
import { fixture, reset, api, call, text, builder, critic } from "./hooks.host.js";
import { components, rawAssignment } from "./fixture/api.js";
import { setup } from "./message-ids.fixture.js";
import { requireReceipt } from "./receipt.js";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

type Test = ReturnType<typeof setup>["t"];
type Event = { turn: number; text: string; messageIds: string[] };
const owner = (t: Test) => t.withIdentity({ subject: "alice" });

const open = (t: Test) =>
  owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "request", requestKey: "request" })
    .then(requireReceipt);

const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);

/** Read each advertised id directly and require successful native assistant rows. */
async function savedReplies(t: Test, event: Event) {
  const messages = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: event.messageIds,
  });

  expect(messages).toHaveLength(event.messageIds.length);

  for (const [index, message] of messages.entries()) {
    expect(message).toMatchObject({
      _id: event.messageIds[index],
      status: "success",
      message: { role: "assistant" },
    });
  }

  return messages;
}

/** The witness is native save output, never a native transcript query. */
function assistantIds(messages: MessageDoc[]) {
  return messages
    .filter((message) => message.status === "success" && message.message?.role === "assistant")
    .map((message) => String(message._id));
}

beforeEach(() => {
  reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["stream", "generate"] as const)(
  "%s afterTurn reports all saved assistant ids in save order across tool slices",
  async (mode) => {
    fixture.run.Main = { mode, stepsPerTurn: RUN_LIMITS.stepsPerTurn.max };

    fixture.steps.Main = (n) =>
      n < 2 ? [...text(`narration ${n}`), ...call("echo", { text: `effect ${n}` })] : text("reply");

    const events: Event[] = [];

    fixture.hooks.afterTurn = (_hc, event) => {
      events.push(event);
    };

    const { t, saves } = setup();
    const receipt = await open(t);

    await drain(t);
    const steps = saves.filter((batch) => assistantIds(batch).length);

    expect(steps).toHaveLength(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ turn: 1, text: "reply", messageIds: steps.flatMap(assistantIds) });
    expect(events[0].messageIds).toHaveLength(3);
    const replies = await savedReplies(t, events[0]);
    const reply = replies[replies.length - 1];

    expect(reply).toMatchObject({ threadId: receipt.threadId, text: "reply" });

    expect(steps.slice(0, 2).every((batch) => batch.some((m) => m.message?.role === "tool"))).toBe(
      true,
    );

    expect(fixture.effects).toEqual(["effect 0", "effect 1"]);
  },
);

it("afterTurn includes saved assistant tool calls and excludes separate native tool-result rows", async () => {
  fixture.builderSides = [];

  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "task" }) : text("done");

  const events: Event[] = [];

  fixture.hooks.afterTurn = (_hc, event) => {
    events.push(event);
  };

  const { t, saves } = setup();
  const receipt = await open(t);

  await drain(t);

  const steps = saves.filter(
    (batch) => batch.some((m) => m.threadId === receipt.threadId) && assistantIds(batch).length,
  );

  expect(events.map((event) => event.messageIds)).toEqual(steps.map(assistantIds));
  expect(events).toHaveLength(2);
  const [reply] = await savedReplies(t, events[0]);

  expect(reply?.message?.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "tool-call" })]),
  );

  expect(steps[0].some((m) => m.message?.role === "tool")).toBe(true);
  await savedReplies(t, events[1]);
});

it("afterTurn continuations report only their own saved replies, even when reply text repeats", async () => {
  const events: Event[] = [];

  fixture.steps.Main = () => text("same reply");

  fixture.hooks.afterTurn = (_hc, event) => {
    events.push(event);

    return event.turn < 3 ? { continue: "continue" } : undefined;
  };

  const { t, saves } = setup();

  await open(t);
  await drain(t);
  const steps = saves.filter((batch) => batch.some((message) => message.usage));

  expect(events).toHaveLength(3);
  expect(events.map((event) => event.messageIds)).toEqual(steps.map(assistantIds));
  expect(new Set(events.flatMap((event) => event.messageIds)).size).toBe(3);

  for (const event of events) expect((await savedReplies(t, event))[0]?.text).toBe("same reply");
});

it("an approval resume reports pre-pause and resumed ids together and preserves the request prompt", async () => {
  fixture.approval = true;
  const seen: ToolContext[] = [];

  fixture.toolWork = async (tc) => {
    seen.push(tc);
  };

  fixture.steps.Main = (n) =>
    n === 0
      ? [...text("before approval"), ...call("echo", { text: "effect" })]
      : n === 1
        ? call("managed", {})
        : text("approved reply");

  const events: Event[] = [];

  fixture.hooks.afterTurn = (_hc, event) => {
    events.push(event);
  };

  const { t, saves } = setup();
  const receipt = await open(t);

  await drain(t);
  const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

  const [request] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [row!.approvals!.requests[0].messageId],
  });

  const content = request!.message!.content;

  const part = Array.isArray(content)
    ? content.find((p) => p.type === "tool-approval-request")
    : undefined;

  if (part?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");

  const priorEvents = events.length;

  expect(events).toHaveLength(0);

  await owner(t).mutation(api.agents.respond, {
    threadId: receipt.threadId,
    approvalId: part.approvalId,
    decision: { kind: "approve" },
  });

  await drain(t);
  const resumed = events.slice(priorEvents);
  const steps = saves.filter((batch) => assistantIds(batch).length);

  expect(resumed).toHaveLength(1);
  expect(resumed[0].messageIds).toEqual(steps.flatMap(assistantIds));
  expect(resumed[0].messageIds).toContain(request!._id);
  expect(seen.map((tc) => tc.promptMessageId)).toEqual([saves[0][0]._id]);
  const replies = await savedReplies(t, resumed[0]);

  expect(replies[replies.length - 1]?.text).toBe("approved reply");
  expect(fixture.effects).toEqual(["effect"]);
});

it("fence abort drops late step saves and never advertises their ids in afterTurn", async () => {
  let release!: () => void;

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const events: Event[] = [];

  fixture.steps.Main = async (n) => {
    if (n === 0) return call("echo", { text: "saved tool step" });

    if (n === 1) await held;

    return text(n === 1 ? "late reply" : "fresh reply");
  };

  fixture.hooks.afterTurn = (_hc, event) => {
    events.push(event);
  };

  const { t, saves } = setup();
  const receipt = await open(t);

  await expect
    .poll(async () => {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      return fixture.calls.length;
    })
    .toBe(2);

  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  release();
  await drain(t);
  expect(events).toEqual([]);

  expect(
    saves.flat().some((message) => message.status === "success" && message.text === "late reply"),
  ).toBe(false);

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "fresh",
    requestKey: "fresh",
  });

  await drain(t);
  expect(events).toHaveLength(1);
  expect((await savedReplies(t, events[0]))[0]?.text).toBe("fresh reply");
  expect(events[0].messageIds).not.toContain(assistantIds(saves.flat())[0]);
});

it.each(["managed", "metered_once"])(
  "%s tools receive the trusted root request id across tool-step slices",
  async (name) => {
    const seen: ToolContext[] = [];

    fixture.steps.Main = (n) => (n < 2 ? call(name, {}) : text("done"));

    fixture.toolWork = async (tc) => {
      seen.push(tc);
    };

    const { t, saves } = setup();
    const receipt = await open(t);
    const requestId = saves[0][0]._id;

    await drain(t);
    expect(seen).toHaveLength(2);
    expect(seen.map((tc) => tc.promptMessageId)).toEqual([requestId, requestId]);

    const [prompt] = await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [seen[0].promptMessageId!],
    });

    expect(prompt).toMatchObject({
      _id: requestId,
      threadId: receipt.threadId,
      message: { role: "user" },
      text: "request",
    });
  },
);

it("a child tool receives its native task message id rather than the parent's request id", async () => {
  const seen: ToolContext[] = [];

  const tools = {
    probe: tool({
      inputSchema: z.object({}),
      execute: async (_input, options) => {
        seen.push(options.context as ToolContext);

        return "done";
      },
    }),
  };

  vi.spyOn(builder as { declaredTools: ToolSet }, "declaredTools", "get").mockReturnValue(tools);
  fixture.builderSides = [];

  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "child task" }) : text("done");

  fixture.steps.Builder = (n) => (n === 0 ? call("probe", {}) : text("child reply"));
  const { t, saves } = setup();
  const receipt = await open(t);

  await drain(t);
  expect(seen).toHaveLength(1);
  expect(seen[0].promptMessageId).not.toBe(saves[0][0]._id);
  expect(seen[0].threadId).not.toBe(receipt.threadId);

  const [prompt] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [seen[0].promptMessageId!],
  });

  expect(prompt).toMatchObject({
    threadId: seen[0].threadId,
    message: { role: "user" },
    text: "child task",
  });
});

it("queued sends and afterTurn continuations give tools their own request prompts and fresh reply lists", async () => {
  const seen: ToolContext[] = [];
  const events: Event[] = [];

  fixture.toolWork = async (tc) => {
    seen.push(tc);
  };

  fixture.steps.Main = (n) => (n % 2 === 0 ? call("managed", {}) : text("reply"));

  fixture.hooks.afterTurn = (_hc, event) => {
    events.push(event);

    return event.turn === 1 ? { continue: "staged continuation" } : undefined;
  };

  const { t, saves } = setup();
  const receipt = await open(t);

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "queued request",
    requestKey: "queued",
  });

  await drain(t);
  expect(events).toHaveLength(3);
  expect(seen).toHaveLength(3);

  const prompts = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: seen.map((tc) => tc.promptMessageId!),
  });

  expect(prompts.map((m) => m?.text)).toEqual(["request", "staged continuation", "queued request"]);
  const steps = saves.filter((batch) => batch.some((m) => m.usage));

  expect(events.map((e) => e.messageIds)).toEqual([
    steps.slice(0, 2).flatMap(assistantIds),
    steps.slice(2, 4).flatMap(assistantIds),
    steps.slice(4, 6).flatMap(assistantIds),
  ]);
});

it("side review tools receive their own task prompt across tool continuations", async () => {
  const seen: ToolContext[] = [];

  const tools = {
    probe: tool({
      inputSchema: z.object({}),
      execute: async (_input, options) => {
        seen.push(options.context as ToolContext);

        return "done";
      },
    }),
  };

  vi.spyOn(critic as { declaredTools: ToolSet }, "declaredTools", "get").mockReturnValue(tools);
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  fixture.steps.Critic = (n) => (n < 2 ? call("probe", {}) : text("review"));
  const { t, saves } = setup();
  const receipt = await open(t);

  await drain(t);
  expect(seen).toHaveLength(2);
  expect(seen[0].promptMessageId).toBe(seen[1].promptMessageId);
  expect(seen[0].promptMessageId).not.toBe(saves[0][0]._id);
  expect(seen[0].threadId).not.toBe(receipt.threadId);

  const [prompt] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [seen[0].promptMessageId!],
  });

  expect(prompt).toMatchObject({ threadId: seen[0].threadId, message: { role: "user" } });
});

it("the assignment stays bounded while reporting the maximum 64 saved model steps", async () => {
  fixture.run.Main = { mode: "generate", stepsPerTurn: RUN_LIMITS.stepsPerTurn.max };

  fixture.steps.Main = (n) =>
    n < RUN_LIMITS.stepsPerTurn.max - 1 ? call("echo", { text: String(n) }) : text("final");

  const events: Event[] = [];

  fixture.hooks.afterTurn = (_hc, e) => {
    events.push(e);
  };

  const { t, saves } = setup();
  const receipt = await open(t);

  await drain(t);
  expect(events).toHaveLength(1);
  expect(events[0].messageIds).toEqual(saves.flatMap(assistantIds));
  expect(events[0].messageIds).toHaveLength(RUN_LIMITS.stepsPerTurn.max);
  const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

  expect(getConvexSize(row)).toBeLessThanOrEqual(LIMITS.assignmentBytes);
  await savedReplies(t, events[0]);
});

it.each([false, true])(
  "cancel arriving inside a native save leaves no nonexistent reported id (rollback=%s)",
  async (rollback) => {
    let release!: () => void;
    let entered!: () => void;

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });

    let intercepted = false;
    const events: Event[] = [];

    fixture.steps.Main = (n) => text(n === 0 ? "racing reply" : "fresh reply");

    fixture.hooks.afterTurn = (_hc, e) => {
      events.push(e);
    };

    const { t, saves } = setup(undefined, async (messages) => {
      if (intercepted || !assistantIds(messages).length) return;

      intercepted = true;
      entered();
      await held;

      if (rollback) throw new Error("ROLLBACK_NATIVE_SAVE");
    });

    const receipt = await open(t);
    const running = drain(t);

    await saving;
    // The nested native save is open. Convex serializes cancel behind this
    // transaction; either save+ids commit together or both roll back.
    const cancelling = owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

    release();
    await cancelling;
    await running;

    for (const event of events) await savedReplies(t, event);

    const ids = assistantIds(saves.flat());
    const native = await t.query(components.agent.messages.getMessagesByIds, { messageIds: ids });

    expect(native.filter((m) => m?.status === "success")).toHaveLength(rollback ? 0 : 1);
    const cancelled = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

    expect(cancelled?.turnReport?.messageIds).toEqual(rollback ? [] : ids);

    await owner(t).mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "fresh",
      requestKey: "fresh-after-race",
    });

    await drain(t);
    const event = events[events.length - 1]!;

    expect(event.messageIds).toHaveLength(1);
    expect((await savedReplies(t, event))[0]?.text).toBe("fresh reply");
  },
);

it.each(["run", "host"] as const)(
  "approval resumes cannot renew the %s step allowance",
  async (cap) => {
    fixture.approval = true;
    fixture.run.Main = { stepsPerTurn: cap === "run" ? 2 : RUN_LIMITS.stepsPerTurn.max };
    fixture.steps.Main = () => call("echo", { text: "approved effect" });
    const events: Event[] = [];

    fixture.hooks.afterTurn = (_hc, event) => {
      events.push(event);
    };

    const { t } = setup({ slicesPerTurn: cap === "host" ? 2 : HOST_LIMITS.slicesPerTurn.max });
    const receipt = await open(t);

    await drain(t);

    for (let i = 0; i < 2; i++) {
      const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

      const [request] = await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: [row!.approvals!.requests[0].messageId],
      });

      const content = request!.message!.content;

      const part = Array.isArray(content)
        ? content.find((p) => p.type === "tool-approval-request")
        : undefined;

      if (part?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");

      await owner(t).mutation(api.agents.respond, {
        threadId: receipt.threadId,
        approvalId: part.approvalId,
        decision: { kind: "approve" },
      });

      await drain(t);
    }

    expect(fixture.calls).toHaveLength(2);
    expect(events).toEqual([]);
    const row = await t.query(rawAssignment, { assignmentId: receipt.assignmentId });

    expect(row).toMatchObject({ errorCode: "SLICE_LIMIT", turnStatus: "recovery_required" });
    expect(row?.turnReport?.messageIds).toHaveLength(2);
  },
);
