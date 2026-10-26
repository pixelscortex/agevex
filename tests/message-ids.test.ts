// @vitest-environment edge-runtime
/** Public hook/tool message identities follow native saves and slice fences. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { MessageDoc } from "@convex-dev/agent";
import type { ToolContext } from "../src/client/index.js";
import { RUN_LIMITS } from "../src/component/run-settings.js";
import { fixture, reset, api, call, text, builder } from "./hooks.host.js";
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
  "%s afterTurn reports exactly the completing slice's saved assistant ids after multiple tool steps",
  async (mode) => {
    fixture.run.Main = { mode, stepsPerTurn: RUN_LIMITS.stepsPerTurn.max };
    fixture.steps.Main = (n) => (n < 2 ? call("echo", { text: `effect ${n}` }) : text("reply"));
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
    expect(events[0]).toEqual({ turn: 1, text: "reply", messageIds: assistantIds(steps[2]) });
    expect(events[0].messageIds).toHaveLength(1); // One model step per slice.
    const [reply] = await savedReplies(t, events[0]);

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

it("an approval-resume afterTurn reports only the resumed slice's assistant saves", async () => {
  fixture.approval = true;
  fixture.steps.Main = (n) => (n === 0 ? call("echo", { text: "effect" }) : text("approved reply"));
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
  const priorSaves = saves.length;

  await owner(t).mutation(api.agents.respond, {
    threadId: receipt.threadId,
    approvalId: part.approvalId,
    decision: { kind: "approve" },
  });

  await drain(t);
  const resumed = events.slice(priorEvents);
  const steps = saves.slice(priorSaves).filter((batch) => assistantIds(batch).length);

  expect(resumed).toHaveLength(1);
  expect(resumed[0].messageIds).toEqual(steps.flatMap(assistantIds));
  expect(resumed[0].messageIds).not.toContain(request!._id);
  expect((await savedReplies(t, resumed[0]))[0]?.text).toBe("approved reply");
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
