// @vitest-environment edge-runtime
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { listMessages } from "@convex-dev/agent";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { fixture, reset, exports, api, text, call } from "./hooks.host.js";
import type { AgentHooks, HookContext } from "../src/client/index.js";
import { requireReceipt } from "./receipt.js";
import { HOST_LIMITS, LIMITS, type Limits } from "../src/component/limits.js";
import { components, rawAssignment } from "./fixture/api.js";
const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

function setup(limits?: Partial<Limits>, platformLimits = false) {
  const t = convexTest({
    schema,
    transactionLimits: platformLimits
      ? true
      : { bytesRead: 8 << 20, documentsRead: 8192, documentsWritten: 8000 },
    modules: { ...modules, "./fixture/agents.ts": async () => exports(limits) },
  });

  agent.register(t);
  agevex.register(t);

  return t;
}
type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });

const open = (t: Test) =>
  owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: "first request", requestKey: "first" })
    .then(requireReceipt);

const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
const calls = (name = "Main") => fixture.calls.filter((call) => call.agent === name);

const send = (t: Test, threadId: string, prompt: string) =>
  owner(t).mutation(api.agents.send, { threadId, text: prompt, requestKey: prompt });

const messages = (t: Test, threadId: string) =>
  owner(t).query(api.agents.messages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

const status = (t: Test, threadId: string) => owner(t).query(api.agents.activity, { threadId });

function gate() {
  let release!: () => void;

  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

const waitFor = async (t: Test, check: () => boolean) =>
  expect
    .poll(async () => {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      return check();
    })
    .toBe(true);

beforeEach(() => {
  reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("beforeTurn can block a turn without calling the model or exposing a hook error", async () => {
  fixture.hooks.beforeTurn = () => ({ block: "intent refused" });
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(calls()).toHaveLength(0);
  expect((await status(t, receipt.threadId)).turnStatus).toBe("idle");
});

it("beforeTurn notes become escaped user-role context in the same turn", async () => {
  fixture.hooks.beforeTurn = async (hc) => {
    expect(hc.subject).toBe("alice");
    expect(hc.signal.aborted).toBe(false);
    const charge = await hc.meter.estimate("test", { quantity: 1 });

    await charge.settle({ usd: 0 });

    return { note: '<advice from="x">' };
  };

  const t = setup();

  await open(t);
  await drain(t);
  expect(JSON.stringify(calls()[0].args.prompt)).toContain("&lt;advice");

  expect(
    calls()[0].args.prompt.some(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("<note from="),
    ),
  ).toBe(true);
});

it("a host contextHandler runs exactly once and controls the model context", async () => {
  const handler = vi.fn((_ctx, context) => [
    ...context.allMessages,
    { role: "user" as const, content: "host context marker" },
  ]);

  fixture.contextHandler = handler;
  fixture.hooks.beforeTurn = () => ({ note: "host-visible advice" });
  const t = setup();

  await open(t);
  await drain(t);
  expect(handler).toHaveBeenCalledTimes(1);
  const prompt = JSON.stringify(calls()[0].args.prompt);

  expect(prompt).toContain("host context marker");
  expect(prompt.match(/host-visible advice/g)).toHaveLength(1);
});

it("a note posted during A is delivered once to the earlier-queued request B", async () => {
  const held = gate();

  fixture.steps.Main = async (n) => {
    if (n === 0) {
      await held.promise;

      return call("echo", { text: "finish A" });
    }

    return text(`reply ${n}`);
  };

  const t = setup();
  const receipt = await open(t);

  await waitFor(t, () => calls().length === 1);
  await send(t, receipt.threadId, "request B");

  await owner(t).mutation(api.agents.note, {
    threadId: receipt.threadId,
    text: "shared advice for A and B",
    from: "critic",
  });

  held.release();
  await drain(t);
  expect(calls()).toHaveLength(3);
  // A is already running; B is the next turn that can safely claim this note.
  expect(JSON.stringify(calls()[1].args.prompt)).not.toContain("shared advice for A and B");

  expect(JSON.stringify(calls()[2].args.prompt).match(/shared advice for A and B/g)).toHaveLength(
    1,
  );

  expect(JSON.stringify(calls()[1].args.prompt)).not.toContain("request B");
  expect(JSON.stringify(calls()[2].args.prompt)).toContain("request B");
});

it.each(["echo", "native", "once"])(
  "beforeTool rewrites %s arguments and afterTool replaces the visible result",
  async (name) => {
    fixture.steps.Main = (n) => (n === 0 ? call(name, { text: "original" }) : text("finished"));
    fixture.hooks.beforeTool = () => ({ input: { text: "rewritten" } });
    fixture.hooks.afterTool = (_hc, event) => ({ output: `redacted:${String(event.output)}` });
    const t = setup();

    await open(t);
    await drain(t);
    expect(fixture.effects).toEqual(["rewritten"]);
    expect(JSON.stringify(calls()[1].args.prompt)).toContain("redacted:rewritten");
  },
);

it("beforeTool denies an effect and beforeDelegate rewrites or refuses delegation without generic tool hooks", async () => {
  fixture.steps.Main = (n) =>
    n === 0
      ? call("echo", { text: "forbidden" })
      : n === 1
        ? call("agevex_delegate", { agent: "Missing", task: "original" })
        : text("finished");

  fixture.hooks.beforeTool = () => ({ block: "refuse effect" });
  fixture.hooks.beforeDelegate = () => ({ input: { agent: "Builder", task: "rewritten task" } });
  const t = setup();

  await open(t);
  await drain(t);
  expect(fixture.effects).toEqual([]);
  expect(JSON.stringify(calls("Builder")[0].args.prompt)).toContain("rewritten task");
});

it("a throwing tool hook fails the turn with HOOK_FAILED and keeps its private details out of the transcript", async () => {
  fixture.steps.Main = () => call("echo", { text: "effect" });

  fixture.hooks.beforeTool = () => {
    throw new Error("private hook failure");
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBe("HOOK_FAILED");
  expect(fixture.effects).toEqual([]);
  expect(JSON.stringify(await messages(t, receipt.threadId))).not.toContain("private hook failure");
});

it.each(["idle", "mid-slice"])(
  "%s notes wait for the next turn, then appear once across its slices",
  async (arrival) => {
    const held = gate();
    const t = setup();
    const receipt = await open(t);

    await drain(t);

    const note = () =>
      owner(t).mutation(api.agents.note, {
        threadId: receipt.threadId,
        text: "unique control advice",
        from: "critic",
      });

    fixture.steps.Main = async (n) => {
      if (n === 1) await held.promise;

      return n < 3 ? call("echo", { text: `effect-${n}` }) : text("done");
    };

    if (arrival === "idle") await note();

    await send(t, receipt.threadId, "second ready request");
    await waitFor(t, () => calls().length === 2);

    if (arrival === "mid-slice") await note();

    await send(t, receipt.threadId, "queued future request");
    held.release();
    await drain(t);

    // Mid-turn posts wait for the queued user turn; idle posts join its first claim.
    for (let n = 1; n <= 3; n++) {
      const prompt = JSON.stringify(calls()[n].args.prompt);

      if (arrival === "idle") {
        expect(prompt.match(/unique control advice/g)).toHaveLength(1);

        expect(prompt.indexOf("unique control advice")).toBeLessThan(
          prompt.indexOf("second ready request"),
        );
      } else expect(prompt).not.toContain("unique control advice");

      expect(prompt).not.toContain("queued future request");
    }

    expect(fixture.effects).toEqual(["effect-1", "effect-2"]);
    // Once a new ready boundary owns these historical notes, native history
    // contains them once without explicit replay from the previous turn.
    expect(JSON.stringify(calls()[4].args.prompt).match(/unique control advice/g)).toHaveLength(1);
  },
);

it("maximum in-flight notes retain tool adjacency and appear once within platform limits", async () => {
  // Only pending admission bounds the batch, including the full escaped payload.
  const held = gate();

  fixture.steps.Main = async (n) => {
    if (n === 0) {
      await held.promise;

      return call("echo", { text: "bounded step" });
    }

    return text("done");
  };

  const t = setup(
    {
      notesPending: HOST_LIMITS.notesPending.max,
    },
    true,
  );

  const receipt = await open(t);

  await waitFor(t, () => calls().length === 1);

  for (let n = 0; n < HOST_LIMITS.notesPending.max; n++)
    expect(
      await owner(t).mutation(api.agents.note, {
        threadId: receipt.threadId,
        text: String(n) + '"'.repeat(LIMITS.noteLength - String(n).length),
        from: '"'.repeat(LIMITS.requestKeyLength),
      }),
    ).toBe(true);

  held.release();
  await drain(t);
  // In-flight notes wait for a new turn; a tool-step slice is not a turn.
  expect(JSON.stringify(calls()[1].args.prompt)).not.toContain("<note from=");
  await send(t, receipt.threadId, "claim maximum notes");
  await drain(t);
  expect(calls()).toHaveLength(3);

  expect(
    calls()[2].args.prompt.filter((message) =>
      JSON.stringify(message.content).includes("<note from="),
    ),
  ).toHaveLength(HOST_LIMITS.notesPending.max);

  expect(fixture.effects).toEqual(["bounded step"]);
  // Maximum escaped notes span the transcript reader's byte-limited pages.
  let cursor: string | null = null;
  let noteCount = 0;

  do {
    const page: Awaited<ReturnType<typeof messages>> = await owner(t).query(api.agents.messages, {
      threadId: receipt.threadId,
      paginationOpts: { cursor, numItems: 100 },
    });

    noteCount += page.page.filter((message) => message.text.includes("<note from=")).length;
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
  expect(noteCount).toBe(HOST_LIMITS.notesPending.max);
});

it("registration rejects a sixteenth active descendant to preserve cancel headroom", () => {
  expect(() => exports({ activeChildrenPerRoot: 15 })).not.toThrow();

  expect(() => exports({ activeChildrenPerRoot: 16 })).toThrow(
    "INVALID_LIMITS: activeChildrenPerRoot exceeds maximum 15",
  );
});

it("an idle note never starts a turn and is included when the next user request arrives", async () => {
  const t = setup();
  const receipt = await open(t);

  await drain(t);

  expect(
    await owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "wait for next turn",
      from: "critic",
    }),
  ).toBe(true);

  await drain(t);
  expect(calls()).toHaveLength(1);
  expect((await status(t, receipt.threadId)).turnStatus).toBe("idle");
  await send(t, receipt.threadId, "second request");
  await drain(t);
  expect(JSON.stringify(calls()[1].args.prompt)).toContain("wait for next turn");

  expect(
    (await messages(t, receipt.threadId)).page.some(
      (message) => message.role === "user" && message.text.includes('<note from="critic">'),
    ),
  ).toBe(true);
});

it("an idle note leaves queueLength one available for the next send", async () => {
  const t = setup({ queueLength: 1 });
  const receipt = await open(t);

  await drain(t);

  expect(
    await owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "passive advice",
      from: "critic",
    }),
  ).toBe(true);

  expect(await send(t, receipt.threadId, "accepted after idle note")).toMatchObject({
    status: "accepted",
  });

  await drain(t);
  expect(calls()).toHaveLength(2);
  expect(JSON.stringify(calls()[1].args.prompt)).toContain("passive advice");
});

it("a running request leaves notes for queued future work without exposing that work across slices", async () => {
  const held = gate();

  fixture.steps.Main = async (n) => {
    if (n === 0) await held.promise;

    return n < 2 ? call("echo", { text: `slice ${n}` }) : text(`answer ${n}`);
  };

  const t = setup();
  const receipt = await open(t);

  await waitFor(t, () => calls().length === 1);
  expect(await send(t, receipt.threadId, "future request B")).toMatchObject({ status: "accepted" });

  expect(
    await owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: '<advice for="A">',
      from: 'critic"',
    }),
  ).toBe(true);

  held.release();
  await drain(t);
  expect(calls()).toHaveLength(4);

  for (const index of [1, 2]) {
    const prompt = JSON.stringify(calls()[index].args.prompt);

    expect(prompt).toContain("first request");
    // Current-turn slices never claim notes, so tool history remains untouched.
    expect(prompt).not.toContain("&lt;advice for=&quot;A&quot;&gt;");
    expect(prompt).not.toContain("future request B");
  }

  expect(JSON.stringify(calls()[3].args.prompt)).toContain("future request B");
  expect(JSON.stringify(calls()[3].args.prompt)).toContain("&lt;advice for=&quot;A&quot;&gt;");
  expect(JSON.stringify(calls()[3].args.prompt)).toContain("critic&quot;");
  expect(fixture.effects).toEqual(["slice 0", "slice 1"]);
  expect((await status(t, receipt.threadId)).queuedMessages).toBe(0);

  expect(
    (await messages(t, receipt.threadId)).page.filter((message) =>
      message.text.includes('<note from="critic&quot;">'),
    ),
  ).toHaveLength(1);
});

it("two in-flight notes preserve the tool pair, arrival order and single delivery while the third gets a typed cap", async () => {
  const held = gate();

  fixture.steps.Main = async (n) => {
    if (n === 0) {
      await held.promise;

      return call("echo", { text: "continue A" });
    }

    return text("done");
  };

  // All admitted notes drain together; there is no second per-turn admission.
  const t = setup({ queueLength: 1, notesPending: 2 }, true);
  const receipt = await open(t);

  await waitFor(t, () => calls().length === 1);
  expect(await send(t, receipt.threadId, "queued B")).toMatchObject({ status: "accepted" });

  const note = (text: string) =>
    owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text,
      from: "critic",
    });

  expect(await note("first passive note")).toBe(true);
  expect(await note("second passive note")).toBe(true);

  // In-flight payloads must never become provisional native messages.
  expect(
    (await messages(t, receipt.threadId)).page.filter((message) => message.origin === "note"),
  ).toEqual([]);

  await expect(note("over pending capacity")).rejects.toMatchObject({
    data: { code: "NOTES_PENDING_LIMIT" },
  });

  held.release();
  await drain(t);
  expect(calls()).toHaveLength(3);
  // The queued request claims notes only after the entire tool turn finishes.
  expect(JSON.stringify(calls()[1].args.prompt)).not.toContain("first passive note");
  const prompt = JSON.stringify(calls()[2].args.prompt);

  expect(prompt.match(/first passive note/g)).toHaveLength(1);
  expect(prompt.match(/second passive note/g)).toHaveLength(1);

  expect(prompt.indexOf("second passive note")).toBeGreaterThan(
    prompt.indexOf("first passive note"),
  );

  const native = (
    await t.run((ctx) =>
      listMessages(ctx, components.agent, {
        threadId: receipt.threadId,
        paginationOpts: { cursor: null, numItems: 100 },
      }),
    )
  ).page.sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);

  expect(native.every((message) => message.status === "success")).toBe(true);

  expect(new Set(native.map((message) => `${message.order}:${message.stepOrder}`)).size).toBe(
    native.length,
  );

  const callIndex = native.findIndex(
    (message) =>
      message.message?.role === "assistant" &&
      Array.isArray(message.message.content) &&
      message.message.content.some((part) => part.type === "tool-call"),
  );

  expect(callIndex).toBeGreaterThanOrEqual(0);
  expect(native[callIndex + 1].message?.role).toBe("tool");
  expect(native[callIndex + 2].text).toBe("done");
  expect(native[callIndex + 3].text).toContain("first passive note");
  expect(native[callIndex + 4].text).toContain("second passive note");
  expect(native[callIndex + 4].order).toBe(native[callIndex].order);
  const page = (await messages(t, receipt.threadId)).page;

  expect(page.every((message) => message.status !== "failed")).toBe(true);

  const controls = page
    .filter((message) => message.origin === "note")
    .sort((a, b) => a.stepOrder - b.stepOrder);

  expect(controls.map((message) => message.text)).toEqual([
    '<note from="critic">first passive note</note>',
    '<note from="critic">second passive note</note>',
  ]);

  expect(new Set(page.map((message) => `${message.order}:${message.stepOrder}`)).size).toBe(
    page.length,
  );

  expect(JSON.stringify(calls()[2].args.prompt)).toContain("second passive note");
  expect(await note("capacity is reusable")).toBe(true);
});

it("two idle notes at capacity stay pending until the next request and are delivered exactly once", async () => {
  // Idle posts wait for claim too, so no post can split a paused tool pair.
  const t = setup({ notesPending: 2 }, true);
  const receipt = await open(t);

  await drain(t);

  for (const text of ["idle first", "idle second"]) {
    await owner(t).mutation(api.agents.note, { threadId: receipt.threadId, text, from: "critic" });
  }

  const page = (await messages(t, receipt.threadId)).page;

  expect(page.filter((message) => message.origin === "note")).toHaveLength(0);
  expect(calls()).toHaveLength(1);
  expect(page.every((message) => message.status === "success")).toBe(true);

  await expect(
    owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "third",
      from: "critic",
    }),
  ).rejects.toMatchObject({ data: { code: "NOTES_PENDING_LIMIT" } });

  await send(t, receipt.threadId, "read idle notes");
  await drain(t);
  const prompt = JSON.stringify(calls()[1].args.prompt);

  expect(prompt.match(/idle first/g)).toHaveLength(1);
  expect(prompt.match(/idle second/g)).toHaveLength(1);
  expect(prompt.indexOf("idle second")).toBeGreaterThan(prompt.indexOf("idle first"));
});

it("authorized messages identify user, delegation result and note origins from recorded ids", async () => {
  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "origin task" }) : text("done");

  const t = setup(undefined, true);
  const receipt = await open(t);

  await drain(t);

  await owner(t).mutation(api.agents.note, {
    threadId: receipt.threadId,
    text: "origin advice",
    from: "critic",
  });

  await send(t, receipt.threadId, "read origins");
  await drain(t);
  const page = (await messages(t, receipt.threadId)).page;

  expect(page.find((message) => message.text === "first request")).toMatchObject({
    origin: "user",
  });

  expect(page.find((message) => message.text.includes("origin advice"))).toMatchObject({
    origin: "note",
    from: "critic",
  });

  const runs = await owner(t).query(api.agents.delegations, {
    threadId: receipt.threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

  const child = runs.page.find((run) => run.agent === "Builder")!;

  expect(page.find((message) => message.id === child.resultMessageId)).toMatchObject({
    origin: "result",
    runId: child.runId,
  });

  await expect(
    t.withIdentity({ subject: "mallory" }).query(api.agents.messages, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    }),
  ).rejects.toThrow("FORBIDDEN");
});

it("a note arriving in a running slice waits for the next turn", async () => {
  const held = gate();

  fixture.steps.Main = async (n) => {
    if (n === 0) {
      await held.promise;

      return call("echo", { text: "effect" });
    }

    return text("done");
  };

  const t = setup();
  const receipt = await open(t);

  await waitFor(t, () => calls().length === 1);

  await owner(t).mutation(api.agents.note, {
    threadId: receipt.threadId,
    text: "between slices",
    from: "critic",
  });

  held.release();
  await drain(t);
  // Ordinary tool slices keep the same turn; only a new claim delivers notes.
  expect(JSON.stringify(calls()[1].args.prompt)).not.toContain("between slices");
  await send(t, receipt.threadId, "next turn");
  await drain(t);
  expect(JSON.stringify(calls()[2].args.prompt).match(/between slices/g)).toHaveLength(1);
});

it("notes enforce their hard count and length bounds and authorize the watched thread", async () => {
  // The pending maximum is the sole note count policy.
  const t = setup({
    notesPending: HOST_LIMITS.notesPending.max,
    queueLength: HOST_LIMITS.queueLength.max,
  });

  const receipt = await open(t);

  await drain(t);

  for (let i = 0; i < HOST_LIMITS.notesPending.max; i++)
    expect(
      await owner(t).mutation(api.agents.note, {
        threadId: receipt.threadId,
        text: "&".repeat(4000),
        from: "critic",
      }),
    ).toBe(true);

  await expect(
    owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "overflow",
      from: "critic",
    }),
  ).rejects.toMatchObject({ data: { code: "NOTES_PENDING_LIMIT" } });

  await expect(
    t.withIdentity({ subject: "mallory" }).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "unauthorized",
      from: "critic",
    }),
  ).rejects.toThrow("FORBIDDEN");

  await send(t, receipt.threadId, "consume maximum notes");
  await drain(t);
  expect(calls()).toHaveLength(2);
});

it("cancel removes an in-flight note without reading its body in the cancel transaction", async () => {
  const held = gate();

  fixture.steps.Main = async () => {
    await held.promise;

    return text("late output");
  };

  const t = setup();
  const receipt = await open(t);

  await waitFor(t, () => calls().length === 1);

  await owner(t).mutation(api.agents.note, {
    threadId: receipt.threadId,
    text: "cancelled passive advice",
    from: "critic",
  });

  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);

  expect(JSON.stringify(await messages(t, receipt.threadId))).not.toContain(
    "cancelled passive advice",
  );

  expect(calls()).toHaveLength(1);
  expect((await status(t, receipt.threadId)).turnStatus).toBe("idle");
});

it("beforeDelegate can refuse a child without calling generic tool hooks or spending a launch", async () => {
  fixture.steps.Main = (n) =>
    n === 0
      ? call("agevex_delegate", { agent: "Builder", task: "refused" })
      : text("denial handled");

  fixture.hooks.beforeDelegate = () => ({ block: "declined by host" });

  fixture.hooks.beforeTool = () => {
    throw new Error("reserved tool reached generic hook");
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(calls("Builder")).toHaveLength(0);
  expect(JSON.stringify(calls()[1].args.prompt)).toContain("HOOK_BLOCKED");
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
});

it("a note posted before the first claim precedes the first prompt and never starts another turn", async () => {
  const t = setup(undefined, true);
  const receipt = await open(t);

  await owner(t).mutation(api.agents.note, {
    threadId: receipt.threadId,
    text: "early advice",
    from: "critic",
  });

  expect(
    (await messages(t, receipt.threadId)).page.some((message) => message.origin === "note"),
  ).toBe(false);

  await drain(t);
  expect(calls()).toHaveLength(1);
  const prompt = JSON.stringify(calls()[0].args.prompt);

  expect(prompt.indexOf("early advice")).toBeLessThan(prompt.indexOf("first request"));

  expect(
    (await messages(t, receipt.threadId)).page.filter((message) => message.origin === "note"),
  ).toHaveLength(1);
});

it("claim-time notes follow every result in a multi-tool step and precede the next prompt", async () => {
  const held = gate();

  fixture.steps.Main = async (n) => {
    if (n === 0) {
      await held.promise;

      return [
        ...call("echo", { text: "first effect" }),
        ...call("echo", { text: "second effect" }),
      ];
    }

    return text("complete");
  };

  const t = setup(undefined, true);
  const receipt = await open(t);

  await waitFor(t, () => calls().length === 1);

  await owner(t).mutation(api.agents.note, {
    threadId: receipt.threadId,
    text: "after both tools",
    from: "critic",
  });

  await send(t, receipt.threadId, "next multi-tool request");
  held.release();
  await drain(t);
  expect(JSON.stringify(calls()[1].args.prompt)).not.toContain("after both tools");
  const prompt = JSON.stringify(calls()[2].args.prompt);

  expect(prompt.match(/after both tools/g)).toHaveLength(1);

  expect(prompt.indexOf("after both tools")).toBeLessThan(
    prompt.indexOf("next multi-tool request"),
  );

  const native = (
    await t.run((ctx) =>
      listMessages(ctx, components.agent, {
        threadId: receipt.threadId,
        paginationOpts: { cursor: null, numItems: 100 },
      }),
    )
  ).page.sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);

  const unresolved = new Set<string>();

  for (const doc of native) {
    const message = doc.message;

    if (message?.role === "user" && doc.text?.includes("<note")) expect(unresolved.size).toBe(0);

    if (!Array.isArray(message?.content)) continue;

    for (const part of message.content) {
      if (part.type === "tool-call") unresolved.add(part.toolCallId);

      if (part.type === "tool-result") unresolved.delete(part.toolCallId);
    }
  }

  expect(unresolved.size).toBe(0);
  // Native Agent executes both tools concurrently; only their completion before
  // the note is promised above, not the order in which their effects finish.
  expect([...fixture.effects].sort()).toEqual(["first effect", "second effect"]);
});

it.each([true, false])(
  "beforeTurn notes on an approved=%s continuation wait for a safe claim and arrive once",
  async (approved) => {
    fixture.approval = true;

    fixture.steps.Main = (n) =>
      n === 0 ? call("echo", { text: "approval effect" }) : text("complete");

    let turns = 0;

    fixture.hooks.beforeTurn = () =>
      ++turns === 2 ? { note: "approval continuation advice" } : undefined;

    const t = setup({ notesPending: 1 }, true);
    const receipt = await open(t);

    await drain(t);

    const execution = await t.query(rawAssignment, {
      assignmentId: receipt.assignmentId,
    });

    const [request] = await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [execution!.approvals!.requests[0].messageId],
    });

    const content = request!.message!.content;

    const part = Array.isArray(content)
      ? content.find((part) => part.type === "tool-approval-request")
      : undefined;

    if (part?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");

    await owner(t).mutation(api.agents.respond, {
      threadId: receipt.threadId,
      approvalId: part.approvalId,
      decision: { kind: approved ? "approve" : "reject" },
    });

    await drain(t);
    expect(calls()).toHaveLength(2);
    expect(JSON.stringify(calls()[1].args.prompt)).not.toContain("approval continuation advice");

    expect(
      (await messages(t, receipt.threadId)).page.filter((message) => message.origin === "note"),
    ).toHaveLength(0);

    expect(await t.query(rawAssignment, { assignmentId: receipt.assignmentId })).toMatchObject({
      notesPending: 1,
    });

    await expect(
      owner(t).mutation(api.agents.note, {
        threadId: receipt.threadId,
        text: "over capacity",
        from: "critic",
      }),
    ).rejects.toMatchObject({ data: { code: "NOTES_PENDING_LIMIT" } });

    await send(t, receipt.threadId, "ordinary request after approval");
    await drain(t);
    expect(calls()).toHaveLength(3);

    expect(await status(t, receipt.threadId)).toMatchObject({
      turnStatus: "idle",
      errorCode: null,
    });

    expect(
      JSON.stringify(calls()[2].args.prompt).match(/approval continuation advice/g),
    ).toHaveLength(1);

    const native = (
      await t.run((ctx) =>
        listMessages(ctx, components.agent, {
          threadId: receipt.threadId,
          paginationOpts: { cursor: null, numItems: 100 },
        }),
      )
    ).page.sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);

    const unresolved = new Set<string>();

    for (const doc of native) {
      const message = doc.message;

      if (message?.role === "user") expect(unresolved.size).toBe(0);

      if (!Array.isArray(message?.content)) continue;

      for (const part of message.content) {
        if (part.type === "tool-call") unresolved.add(part.toolCallId);

        if (part.type === "tool-result") unresolved.delete(part.toolCallId);
      }
    }

    expect(unresolved.size).toBe(0);

    expect(
      (await messages(t, receipt.threadId)).page.filter((message) => message.origin === "note"),
    ).toMatchObject([{ text: '<note from="Main">approval continuation advice</note>' }]);

    await send(t, receipt.threadId, "another ordinary request");
    await drain(t);
    expect(calls()).toHaveLength(4);

    expect(
      (await messages(t, receipt.threadId)).page.filter((message) => message.origin === "note"),
    ).toHaveLength(1);

    expect(fixture.effects).toEqual(approved ? ["approval effect"] : []);
  },
);

it("a beforeTurn model choice applies only to its own generation step", async () => {
  let steps = 0;
  const prompts: string[] = [];

  fixture.hooks.beforeTurn = (_hc, event) => {
    prompts.push(event.prompt);

    return steps++ === 0 ? { model: "routed" } : undefined;
  };

  fixture.steps.Routed = () => call("echo", { text: "routed effect" });
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(calls("Routed")).toHaveLength(1);
  expect(calls()).toHaveLength(1);
  expect(prompts).toEqual(["first request", "first request"]);
  await send(t, receipt.threadId, "next request");
  await drain(t);
  expect(calls("Routed")).toHaveLength(1);
  expect(calls()).toHaveLength(2);
});

it("beforeTurn keeps a model across tool steps by returning it every time", async () => {
  fixture.hooks.beforeTurn = () => ({ model: "routed" });

  fixture.steps.Routed = (n) => (n === 0 ? call("echo", { text: "effect" }) : text("finished"));
  const t = setup();

  await open(t);
  await drain(t);
  expect(calls("Routed")).toHaveLength(2);
  expect(calls()).toHaveLength(0);
});

it("a model choice outside the registered allowlist fails before paid generation", async () => {
  fixture.hooks.beforeTurn = () => ({ model: "unregistered" });
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(fixture.calls).toHaveLength(0);
  expect((await status(t, receipt.threadId)).errorCode).toBe("HOOK_FAILED");
});

it("concurrent sibling beforeTurn hooks choose models independently without a routing lock", async () => {
  const held = gate();
  let decisions = 0;

  fixture.steps.Main = (n) =>
    n === 0
      ? [
          ...call("agevex_delegate", { agent: "Builder", task: "held model decision" }),
          ...call("agevex_delegate", { agent: "Builder", task: "independent decision" }),
        ]
      : text("done");

  fixture.builderHooks.beforeTurn = async () => {
    if (++decisions === 1) {
      await held.promise;

      return { model: "routed" };
    }
  };

  const t = setup();

  await open(t);
  await waitFor(t, () => calls("Builder").length === 1);
  expect(decisions).toBe(2);
  expect(calls("Routed")).toHaveLength(0);
  held.release();
  await drain(t);
  expect(calls("Routed")).toHaveLength(1);
  expect(calls("Builder")).toHaveLength(1);
});

it("afterTurn is a notification whose accidental return values cannot change execution", async () => {
  const notified: number[] = [];

  fixture.hooks.afterTurn = ((_hc: HookContext, event: { turn: number }) => {
    notified.push(event.turn);

    return { continue: "must not run", model: "unregistered", note: "must not save" };
  }) as unknown as AgentHooks["afterTurn"];

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(calls()).toHaveLength(1);
  expect(notified).toHaveLength(1);
  expect((await status(t, receipt.threadId)).turnStatus).toBe("idle");
  expect(JSON.stringify(await messages(t, receipt.threadId))).not.toContain("must not");
});
