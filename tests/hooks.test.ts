// @vitest-environment edge-runtime
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { listMessages } from "@convex-dev/agent";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { fixture, reset, exports, api, critic, text, call } from "./hooks.host.js";
import { requireReceipt } from "./receipt.js";
import { createFunctionHandle } from "convex/server";
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

it("continuation instructions and their replies retain chronological order", async () => {
  fixture.steps.Main = (n) => text(`reply${n}`);
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn <= 2 ? { continue: `instruction${event.turn}` } : undefined;
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  const prompt = JSON.stringify(calls()[2].args.prompt);
  const ordered = ["reply0", "instruction1", "reply1", "instruction2"];
  for (let n = 1; n < ordered.length; n++)
    expect(prompt.indexOf(ordered[n])).toBeGreaterThan(prompt.indexOf(ordered[n - 1]));
  await send(t, receipt.threadId, "later request");
  await drain(t);
  const history = JSON.stringify(calls()[3].args.prompt);
  const chronology = ["instruction1", "reply1", "instruction2", "reply2"];
  for (const entry of chronology) expect(history.match(new RegExp(entry, "g"))).toHaveLength(1);
  for (let n = 1; n < chronology.length; n++)
    expect(history.indexOf(chronology[n])).toBeGreaterThan(history.indexOf(chronology[n - 1]));
});

it("beforeTurn receives each continuation's own prompt", async () => {
  const prompts: string[] = [];
  fixture.hooks.beforeTurn = (_hc, event) => {
    prompts.push(event.prompt);
  };
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn <= 2 ? { continue: `instruction${event.turn}` } : undefined;
  const t = setup();
  await open(t);
  await drain(t);
  expect(prompts).toEqual(["first request", "instruction1", "instruction2"]);
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
    fixture.hooks.afterTool = (_hc, event) => ({ output: `redacted:${event.output}` });
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

it("model routing applies only at run start and persists across hook continuations", async () => {
  const starts: boolean[] = [];
  fixture.hooks.beforeTurn = (_hc, event) => {
    starts.push(event.isRunStart);
    return event.isRunStart ? { model: "routed" } : undefined;
  };
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn === 1 ? { continue: "check again" } : undefined;
  const t = setup();
  await open(t);
  await drain(t);
  expect(starts).toEqual([true, false]);
  expect(calls("Routed")).toHaveLength(2);
  expect(calls()).toHaveLength(0);
});

it("afterTurn control prompts appear once after the response while future requests stay hidden", async () => {
  const held = gate();
  fixture.steps.Main = async (n) => {
    if (n === 0) await held.promise;
    return text(`response-${n}`);
  };
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn < 3 ? { continue: "check again" } : undefined;
  const t = setup();
  const receipt = await open(t);
  await waitFor(t, () => calls().length === 1);
  await send(t, receipt.threadId, "future request must stay hidden");
  held.release();
  await drain(t);
  for (let n = 1; n <= 2; n++) {
    const prompt = JSON.stringify(calls()[n].args.prompt);
    expect(prompt.match(/check again/g)).toHaveLength(n);
    expect(prompt).not.toContain("future request must stay hidden");
    expect(prompt.lastIndexOf("check again")).toBeGreaterThan(prompt.indexOf(`response-${n - 1}`));
  }
  expect(JSON.stringify(calls()[3].args.prompt)).toContain("future request must stay hidden");
  const transcript = JSON.stringify(await messages(t, receipt.threadId));
  expect(transcript.match(/check again/g)).toHaveLength(4); // Native content and text projection, two distinct prompts.
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

it("distinct identical requests and notes persist once across hook turns", async () => {
  fixture.hooks.beforeTurn = () => ({ note: "same advice" });
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn < 2 ? { continue: "continue marker" } : undefined;
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  const second = JSON.stringify(calls()[1].args.prompt);
  expect(second.match(/same advice/g)).toHaveLength(2); // Two distinct native notes, once each.
  expect(second.match(/continue marker/g)).toHaveLength(1);
  fixture.hooks = {};
  // An ordinary user request can match a note body without being deduplicated.
  await send(t, receipt.threadId, '<note from="Main">same advice</note>');
  await drain(t);
  expect(JSON.stringify(calls()[2].args.prompt).match(/same advice/g)).toHaveLength(3);
});

it("maximum native control history fits platform limits across all eight hook continuations", async () => {
  // Posted hook notes wait for the following claim, including hook continuations.
  fixture.hooks.beforeTurn = async (hc) => {
    const row = await hc.ctx.runQuery(components.agevex.queue.assignment, {
      threadId: hc.threadId,
    });
    for (let n = 0; n < HOST_LIMITS.notesPending.max; n++)
      expect(
        await hc.ctx.runMutation(components.agevex.hooks.addNote, {
          assignmentId: row!.assignmentId,
          text: '"'.repeat(LIMITS.noteLength),
          from: '"'.repeat(LIMITS.requestKeyLength),
        }),
      ).toBe(true);
  };
  fixture.hooks.afterTurn = () => ({ continue: "￿".repeat(LIMITS.messageLength) });
  const t = setup(
    {
      notesPending: HOST_LIMITS.notesPending.max,
      continuesPerRun: HOST_LIMITS.continuesPerRun.max,
    },
    true,
  );
  await open(t);
  await drain(t);
  expect(calls()).toHaveLength(HOST_LIMITS.continuesPerRun.max + 1);
  const prompt = calls()[HOST_LIMITS.continuesPerRun.max].args.prompt;
  expect(
    prompt.filter((message) => JSON.stringify(message.content).includes("<note from=")),
  ).toHaveLength(HOST_LIMITS.continuesPerRun.max * HOST_LIMITS.notesPending.max);
  expect(prompt.filter((message) => JSON.stringify(message.content).includes("￿"))).toHaveLength(
    HOST_LIMITS.continuesPerRun.max,
  );
}, 30_000);

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

it("model returned after run start or outside beforeTurn fails with HOOK_FAILED", async () => {
  fixture.hooks.beforeTurn = (_hc, event) => (event.isRunStart ? undefined : { model: "routed" });
  fixture.hooks.afterTurn = () => ({ continue: "again" });
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBe("HOOK_FAILED");
  expect(calls()).toHaveLength(1);
});

it("afterTurn continuations stop at the per-run cap even when the hook keeps requesting work", async () => {
  fixture.hooks.afterTurn = () => ({ continue: "review again" });
  const t = setup({ continuesPerRun: HOST_LIMITS.continuesPerRun.max });
  await open(t);
  await drain(t);
  expect(calls()).toHaveLength(1 + HOST_LIMITS.continuesPerRun.max);
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

it("authorized messages identify user, delegation result, note and continue origins from recorded ids", async () => {
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
  let continued = false;
  fixture.hooks.afterTurn = () => {
    if (continued) return;
    continued = true;
    return { continue: "origin followup" };
  };
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
  expect(page.find((message) => message.text === "origin followup")).toMatchObject({
    origin: "continue",
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

it("delegations and runTree distinguish side runs from ordinary children", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "ordinary task" }) : text("done");
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  const tree = await owner(t).query(api.agents.runTree, { threadId: receipt.threadId });
  const runs = (
    await owner(t).query(api.agents.delegations, {
      threadId: receipt.threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    })
  ).page;
  for (const records of [tree, runs]) {
    expect(records.find((run) => run.agent === "Builder")).toMatchObject({ side: false });
    expect(records.some((run) => run.agent === "Critic" && run.side === true)).toBe(true);
  }
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

it("side reviews follow turn cadence, preserve skipped deltas and deliver passive notes readable in both threads", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 2 }, sees: "delta" }];
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect(calls("Critic")).toHaveLength(0);
  await send(t, receipt.threadId, "second boundary");
  await drain(t);
  expect(calls("Critic")).toHaveLength(1);
  const first = JSON.stringify(calls("Critic")[0].args.prompt);
  expect(first).toContain("first request");
  expect(first).toContain("second boundary");
  await send(t, receipt.threadId, "third boundary");
  await drain(t);
  await send(t, receipt.threadId, "fourth boundary");
  await drain(t);
  const second = JSON.stringify(calls("Critic")[1].args.prompt);
  expect(second).toContain("third boundary");
  expect(second).not.toContain("first request");
  expect(calls()).toHaveLength(4);
  const tree = await owner(t).query(api.agents.runTree, { threadId: receipt.threadId });
  const child = tree.find((run) => run.agent === "Critic")!;
  expect(
    (await messages(t, child.childThreadId!)).page.some((message) => message.role === "assistant"),
  ).toBe(true);
  expect(
    (await messages(t, receipt.threadId)).page.some((message) =>
      message.text.includes('<note from="Critic">'),
    ),
  ).toBe(true);
});

it("minute cadence compares to the last review without scheduled review chains", async () => {
  fixture.sides = [{ agent: critic, every: { minutes: 1 }, sees: "delta" }];
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect(calls("Critic")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(60_000);
  await send(t, receipt.threadId, "after minute");
  await drain(t);
  expect(calls("Critic")).toHaveLength(1);
  await send(t, receipt.threadId, "too soon");
  await drain(t);
  expect(calls("Critic")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60_000);
  await send(t, receipt.threadId, "another minute");
  await drain(t);
  expect(calls("Critic")).toHaveLength(2);
});

it("side cap is separate from model delegation and NONE posts no note", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn <= 3 ? { continue: "more work" } : undefined;
  fixture.steps.Critic = () => text("NONE");
  const t = setup({ sideRunsPerRun: 2 });
  const receipt = await open(t);
  await drain(t);
  expect(calls("Critic")).toHaveLength(2);
  expect(calls()).toHaveLength(4);
  expect(
    (await messages(t, receipt.threadId)).page.some((message) =>
      message.text.includes('<note from="Critic">'),
    ),
  ).toBe(false);
});

it("a delegated parent settles while its side run is held, and a side failure never fails that parent", async () => {
  const held = gate();
  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "work" }) : text("parent finished");
  fixture.steps.Critic = async () => {
    await held.promise;
    throw new Error("critic failed privately");
  };
  const t = setup();
  const receipt = await open(t);
  await waitFor(t, () => calls("Critic").length === 1 && calls().length === 2);
  expect((await status(t, receipt.threadId)).turnStatus).toBe("idle");
  held.release();
  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
  expect(calls()).toHaveLength(2);
});

it.each(
  (["turn end", "failed each delivery", "empty all release"] as const).flatMap((path) =>
    (["before", "after"] as const).map((sideSettlement) => ({ path, sideSettlement })),
  ),
)(
  "passive notes and side reviews never fence R3 at $path, with side settlement $sideSettlement the parent",
  async ({ path, sideSettlement }) => {
    const t = setup(
      Object.fromEntries(Object.entries(HOST_LIMITS).map(([name, { max }]) => [name, max])),
    );
    const receipt = await open(t);
    const root = { assignmentId: receipt.assignmentId, turnToken: `${receipt.assignmentId}:0` };
    await t.mutation(components.agevex.queue.claim, root);
    const launch = async (
      parent: typeof root,
      agent: string,
      extra: { side?: boolean; group?: string; wait?: "all" } = {},
    ) => {
      const response = await t.mutation(api.agents.coordinate!, {
        op: "launch",
        assignmentId: parent.assignmentId,
        turnToken: parent.turnToken,
        toolCallId: crypto.randomUUID(),
        agent,
        task: "review the work",
        ...extra,
      });
      if (response?.status !== "queued") throw new Error(JSON.stringify(response));
      const tree = await owner(t).query(api.agents.runTree, { threadId: receipt.threadId });
      const child = tree.find((run) => run.runId === response.runId)!;
      const turn = {
        assignmentId: child.childAssignmentId!,
        turnToken: `${child.childAssignmentId}:0`,
      };
      const claimed = await t.mutation(components.agevex.queue.claim, turn);
      return { ...turn, threadId: child.childThreadId!, ...claimed!.subagent! };
    };
    const builder = await launch(root, "Builder");
    const ordinary =
      path === "turn end"
        ? null
        : await launch(
            builder,
            "Critic",
            path === "empty all release" ? { group: "empty", wait: "all" } : {},
          );
    const saved = await t.run(async (ctx) =>
      ctx.runMutation(components.agevex.queue.write, {
        assignmentId: builder.assignmentId,
        executionId: builder.turnToken,
        cancellationEpoch: 0,
        handle: await createFunctionHandle(components.agent.messages.addMessages),
        nativeMessages: {
          getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
          finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
        },
        args: {
          threadId: builder.threadId,
          agentName: "Builder",
          messages: [{ message: { role: "assistant", content: "verified Builder outcome" } }],
        },
      }),
    );
    await t.mutation(components.agevex.hooks.hookState, {
      assignmentId: builder.assignmentId,
      executionId: builder.turnToken,
      complete: true,
    });
    const side = await launch(builder, "Critic", { side: true });
    // Fill the sole passive-note allowance; unsaved bodies stay bounded here.
    // Inbox rows remain present throughout both settlement paths, under
    // the enforced 8 MiB transaction gate; R3 must inspect only ready work.
    for (let n = 0; n < HOST_LIMITS.notesPending.max; n++)
      expect(
        await owner(t).mutation(api.agents.note, {
          threadId: builder.threadId,
          text: `passive review ${n}`,
          from: "critic",
        }),
      ).toBe(true);
    const builderStatus = async () =>
      (await owner(t).query(api.agents.runTree, { threadId: receipt.threadId })).find(
        (run) => run.runId === builder.runId,
      )!.status;
    const fail = async (child: typeof side) => {
      await t.mutation(components.agevex.subagents.settle, {
        assignmentId: child.assignmentId,
        turnToken: child.turnToken,
        runId: child.runId,
        childResultMessageId: null,
        errorCode: "GENERATION_FAILED",
      });
      await t.mutation(components.agevex.subagents.deliver, {
        runId: child.runId,
        deliveryToken: child.deliveryToken,
        deliveryStatus: "failed",
        parentMessageId: null,
        errorCode: "DELIVERY_FAILED",
      });
      await t.mutation(components.agevex.queue.finish, {
        assignmentId: child.assignmentId,
        turnToken: child.turnToken,
        errorCode: null,
      });
    };
    if (sideSettlement === "before" && !ordinary) {
      await fail(side);
      expect(await builderStatus()).toBe("running");
    }
    expect(
      await t.mutation(api.agents.coordinate!, {
        op: "settle",
        assignmentId: builder.assignmentId,
        turnToken: builder.turnToken,
        runId: builder.runId,
        resultMessageId: (saved as { messages: { _id: string }[] }).messages[0]._id,
        errorCode: null,
      }),
    ).toEqual(ordinary ? { status: "deferred", runId: builder.runId } : null);
    await t.mutation(components.agevex.queue.finish, {
      assignmentId: builder.assignmentId,
      turnToken: builder.turnToken,
      errorCode: null,
    });
    if (ordinary) {
      expect(await builderStatus()).toBe("running");
      if (sideSettlement === "before") {
        await fail(side);
        expect(await builderStatus()).toBe("running");
      }
      await fail(ordinary);
    }
    expect(await builderStatus()).toBe("completed");
    if (sideSettlement === "after") {
      await fail(side);
      expect(await builderStatus()).toBe("completed");
    }
    await t.mutation(api.agents.coordinate!, {
      op: "notify",
      runId: builder.runId,
      deliveryToken: builder.deliveryToken,
    });
    await t.mutation(components.agevex.queue.finish, { ...root, errorCode: null });
    await drain(t);
    expect(calls("Builder")).toHaveLength(0);
    expect(calls("Critic")).toHaveLength(0);
    expect(calls()).toHaveLength(1);
    expect(JSON.stringify(calls()[0].args.prompt)).toContain("verified Builder outcome");
  },
);

it("cancel stops side runs and fences their late notes", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  const held = gate();
  fixture.steps.Critic = async () => {
    await held.promise;
    return text("late review");
  };
  const t = setup();
  const receipt = await open(t);
  await waitFor(t, () => calls("Critic").length === 1);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
  expect((await status(t, receipt.threadId)).subagents.active).toBe(0);
  expect(JSON.stringify(await messages(t, receipt.threadId))).not.toContain("late review");
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

it("a model result from afterTurn is rejected even on the first turn", async () => {
  fixture.hooks.afterTurn = () => ({ model: "routed" });
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBe("HOOK_FAILED");
});

it("all side and continuation hard maxima leave the model delegation budget available", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  fixture.steps.Critic = () => text("NONE");
  fixture.steps.Main = (n) =>
    n === HOST_LIMITS.continuesPerRun.max
      ? call("agevex_delegate", { agent: "Builder", task: "one model launch" })
      : text("root work");
  fixture.hooks.afterTurn = (_hc, event) =>
    event.turn <= HOST_LIMITS.continuesPerRun.max
      ? { continue: "continue bounded work" }
      : undefined;
  const t = setup({
    continuesPerRun: HOST_LIMITS.continuesPerRun.max,
    sideRunsPerRun: HOST_LIMITS.sideRunsPerRun.max,
    activeChildrenPerRoot: HOST_LIMITS.activeChildrenPerRoot.max,
    runLaunches: 1,
  });
  const receipt = await open(t);
  await drain(t);
  expect(calls("Critic")).toHaveLength(HOST_LIMITS.sideRunsPerRun.max);
  expect(calls("Builder")).toHaveLength(1);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
});

it("an empty side reply produces no note and never fails its watched turn", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  fixture.steps.Critic = () => text("");
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
  expect(
    (await messages(t, receipt.threadId)).page.some((message) =>
      message.text.includes('<note from="Critic">'),
    ),
  ).toBe(false);
});

it("a maximum-size delta reads bounded exact source ids and sends at most 48 KiB of recent text", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  const t = setup(
    Object.fromEntries(Object.entries(HOST_LIMITS).map(([name, { max }]) => [name, max])),
  );
  const receipt = await open(t);
  const fence = {
    assignmentId: receipt.assignmentId,
    executionId: `${receipt.assignmentId}:0`,
    cancellationEpoch: 0,
  };
  expect(
    await t.mutation(components.agevex.queue.claim, {
      assignmentId: receipt.assignmentId,
      turnToken: fence.executionId,
    }),
  ).not.toBeNull();
  // Each native source is ~900 KiB (body plus text projection). The full ring
  // exceeds 16 MiB; a transcript/body scan would fail the enforced 8 MiB gate.
  for (let index = 0; index < LIMITS.contextMessages; index++) {
    await t.run(async (ctx) =>
      ctx.runMutation(components.agevex.queue.write, {
        ...fence,
        handle: await createFunctionHandle(components.agent.messages.addMessages),
        nativeMessages: {
          getMessages: await createFunctionHandle(components.agent.messages.getMessagesByIds),
          finalizeMessage: await createFunctionHandle(components.agent.messages.finalizeMessage),
        },
        args: {
          threadId: receipt.threadId,
          messages: [
            { message: { role: "assistant", content: `source-${index}:` + "界".repeat(150_000) } },
          ],
        },
      }),
    );
  }
  await t.mutation(components.agevex.hooks.hookState, {
    assignmentId: receipt.assignmentId,
    executionId: fence.executionId,
    complete: true,
  });
  expect(
    await t.mutation(api.agents.coordinate!, {
      op: "launch",
      side: true,
      assignmentId: receipt.assignmentId,
      turnToken: fence.executionId,
      toolCallId: "max-delta",
      agent: "Critic",
      task: "review exact delta",
    }),
  ).toMatchObject({ status: "queued" });
  await t.mutation(components.agevex.queue.finish, {
    assignmentId: receipt.assignmentId,
    turnToken: fence.executionId,
    errorCode: null,
  });
  await drain(t);
  const prompt = calls("Critic")[0]
    .args.prompt.map((message) => JSON.stringify(message.content))
    .join("\n");
  expect(new TextEncoder().encode(prompt).byteLength).toBeLessThan(
    LIMITS.contextBytes + LIMITS.taskLength,
  );
  expect(prompt).toContain(`source-${LIMITS.contextMessages - 1}:`);
  expect(prompt).not.toContain("source-0:");
});

it("concurrent sibling turns share the first run-start model decision without duplicate classifiers", async () => {
  const held = gate();
  const starts: boolean[] = [];
  fixture.steps.Main = (n) =>
    n === 0
      ? [
          ...call("agevex_delegate", { agent: "Builder", task: "one" }),
          ...call("agevex_delegate", { agent: "Builder", task: "two" }),
        ]
      : text("done");
  fixture.builderHooks.beforeTurn = async (_hc, event) => {
    starts.push(event.isRunStart);
    if (event.isRunStart) {
      await held.promise;
      return { model: "routed" };
    }
  };
  const t = setup();
  await open(t);
  await waitFor(t, () => starts.length === 2);
  expect(starts).toEqual([true, false]);
  expect(calls("Builder")).toHaveLength(0);
  expect(calls("Routed")).toHaveLength(0);
  held.release();
  await drain(t);
  expect(calls("Routed")).toHaveLength(2);
  expect(calls("Builder")).toHaveLength(0);
});

it("a denied first Builder releases waiting siblings to the default model without repeating routing", async () => {
  const held = gate();
  let authorizations = 0;
  const starts: boolean[] = [];
  fixture.steps.Main = (n) =>
    n === 0
      ? [
          ...call("agevex_delegate", { agent: "Builder", task: "denied first Builder" }),
          ...call("agevex_delegate", { agent: "Builder", task: "waiting sibling Builder" }),
        ]
      : text("done");
  fixture.authorizeExecution = async (_ctx, scope) => {
    if (scope.agent === "Builder" && ++authorizations === 1) {
      await held.promise;
      throw new Error("private execution denial");
    }
  };
  fixture.builderHooks.beforeTurn = (_hc, event) => {
    starts.push(event.isRunStart);
    if (event.isRunStart) throw new Error("classifier must never be retried");
  };
  const t = setup();
  const receipt = await open(t);
  await waitFor(t, () => starts.length === 1);
  expect(starts).toEqual([false]);
  expect(calls("Builder")).toHaveLength(0);
  held.release();
  await drain(t);
  expect(calls("Builder")).toHaveLength(1);
  expect(JSON.stringify(calls("Builder")[0].args.prompt)).toContain("waiting sibling Builder");
  expect(starts).toEqual([false]);
  const tree = await owner(t).query(api.agents.runTree, { threadId: receipt.threadId });
  expect(tree.filter((run) => run.agent === "Builder").map((run) => run.status)).toEqual(
    expect.arrayContaining(["failed", "completed"]),
  );
  expect(JSON.stringify(await messages(t, receipt.threadId))).not.toContain(
    "private execution denial",
  );
});

it.each(["hook failure", "abandoned action"])(
  "a routing owner's %s releases its sibling without repeating the classifier",
  async (path) => {
    const held = gate();
    const starts: boolean[] = [];
    let ownerThreadId = "";
    fixture.steps.Main = (n) =>
      n === 0
        ? [
            ...call("agevex_delegate", { agent: "Builder", task: "first routing owner" }),
            ...call("agevex_delegate", { agent: "Builder", task: "waiting sibling" }),
          ]
        : text("done");
    fixture.builderHooks.beforeTurn = async (hc, event) => {
      starts.push(event.isRunStart);
      if (event.isRunStart) {
        ownerThreadId = hc.threadId;
        await held.promise;
        if (path === "hook failure") throw new Error("private classifier failure");
        return { model: "routed" };
      }
    };
    const t = setup();
    const receipt = await open(t);
    await waitFor(t, () => starts.length === 2);
    if (path === "abandoned action") {
      const tree = await owner(t).query(api.agents.runTree, { threadId: receipt.threadId });
      const first = tree.find((run) => run.childThreadId === ownerThreadId)!;
      await t.mutation(components.agevex.queue.ambiguous, {
        assignmentId: first.childAssignmentId!,
        turnToken: `${first.childAssignmentId}:0`,
      });
      // The uncooperative owner is still held. Durable terminal fencing must
      // release the sibling before the owner's finally block can possibly run.
      await waitFor(t, () => calls("Builder").length === 1);
    }
    held.release();
    await drain(t);
    expect(starts).toEqual([true, false]);
    expect(calls("Builder")).toHaveLength(1);
    expect(calls("Routed")).toHaveLength(0);
    expect(JSON.stringify(calls("Builder")[0].args.prompt)).toContain("waiting sibling");
    expect(JSON.stringify(await messages(t, receipt.threadId))).not.toContain(
      "private classifier failure",
    );
  },
);

it("queued future prompts never hide an earlier assistant response from the next review delta", async () => {
  fixture.sides = [{ agent: critic, every: { turns: 1 }, sees: "delta" }];
  const held = gate();
  fixture.steps.Main = async (n) => {
    if (n === 0) await held.promise;
    return text(`actual reply ${n}`);
  };
  fixture.steps.Critic = () => text("NONE");
  const t = setup();
  const receipt = await open(t);
  await waitFor(t, () => calls().length === 1);
  await send(t, receipt.threadId, "queued second request");
  await send(t, receipt.threadId, "queued third request");
  held.release();
  await drain(t);
  expect(calls("Critic")).toHaveLength(3);
  const second = JSON.stringify(calls("Critic")[1].args.prompt);
  expect(second).toContain("actual reply 1");
  expect(second).not.toContain("actual reply 0");
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

it.each([false, true])(
  "an afterTurn note waits for the next claim (hook continue=%s) and persists exactly once",
  async (continuation) => {
    fixture.hooks.afterTurn = (_hc, event) =>
      event.turn === 1
        ? { note: "after-turn advice", ...(continuation ? { continue: "follow-up work" } : {}) }
        : undefined;
    const t = setup(undefined, true);
    const receipt = await open(t);
    await drain(t);
    expect(JSON.stringify(calls()[0].args.prompt)).not.toContain("after-turn advice");
    if (!continuation) {
      expect(calls()).toHaveLength(1);
      expect(
        (await messages(t, receipt.threadId)).page.some((message) => message.origin === "note"),
      ).toBe(false);
      await send(t, receipt.threadId, "follow-up work");
      await drain(t);
    }
    const prompt = JSON.stringify(calls()[1].args.prompt);
    expect(prompt.match(/after-turn advice/g)).toHaveLength(1);
    expect(prompt.indexOf("Main answer 0")).toBeLessThan(prompt.indexOf("after-turn advice"));
    expect(prompt.indexOf("after-turn advice")).toBeLessThan(prompt.indexOf("follow-up work"));
    await send(t, receipt.threadId, "one more request");
    await drain(t);
    expect(
      (await messages(t, receipt.threadId)).page.filter((message) => message.origin === "note"),
    ).toMatchObject([
      { from: "Main", origin: "note", text: '<note from="Main">after-turn advice</note>' },
    ]);
  },
);

it("an in-flight note survives a failed child turn and is delivered once at the next result claim", async () => {
  const failure = gate();
  const descendant = gate();
  fixture.builderHooks.afterTurn = (_hc, event) =>
    event.turn === 1 ? { continue: "inspect while helper runs" } : undefined;
  fixture.steps.Main = (n) =>
    n === 0
      ? call("agevex_delegate", { agent: "Builder", task: "build with a helper" })
      : text("root done");
  fixture.steps.Builder = async (n) => {
    if (n === 0) return call("agevex_delegate", { agent: "Critic", task: "check the work" });
    if (n === 1) {
      await failure.promise;
      throw new Error("paid turn failed");
    }
    return text("recovered from child result");
  };
  fixture.steps.Critic = async () => {
    await descendant.promise;
    return text("helper result");
  };
  const t = setup(undefined, true);
  const receipt = await open(t);
  await waitFor(t, () => calls("Builder").length === 2 && calls("Critic").length >= 1);
  const builderRun = (
    await owner(t).query(api.agents.runTree, { threadId: receipt.threadId })
  ).find((run) => run.agent === "Builder")!;
  await owner(t).mutation(api.agents.note, {
    threadId: builderRun.childThreadId!,
    text: "survives failure",
    from: "watchdog",
  });
  failure.release();
  await expect
    .poll(async () => {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      return (
        await t.query(rawAssignment, {
          assignmentId: builderRun.childAssignmentId!,
        })
      )?.turnStatus;
    })
    .toBe("idle");
  expect(
    (await messages(t, builderRun.childThreadId!)).page.some(
      (message) => message.origin === "note",
    ),
  ).toBe(false);
  descendant.release();
  await drain(t);
  expect(JSON.stringify(calls("Builder")[2].args.prompt).match(/survives failure/g)).toHaveLength(
    1,
  );
  expect(
    (await messages(t, builderRun.childThreadId!)).page.filter((message) =>
      message.text.includes("survives failure"),
    ),
  ).toMatchObject([{ origin: "note", from: "watchdog" }]);
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
  expect(fixture.effects).toEqual(["first effect", "second effect"]);
});

it("cancel discards a staged hook continuation and its notes before a fresh send", async () => {
  const t = setup({ notesPending: HOST_LIMITS.notesPending.max }, true);
  const receipt = await open(t);
  const row = (await t.query(rawAssignment, {
    assignmentId: receipt.assignmentId,
  }))!;
  await t.mutation(components.agevex.queue.claim, {
    assignmentId: receipt.assignmentId,
    turnToken: row.turnToken!,
  });
  await t.mutation(components.agevex.hooks.continueAdmission, {
    assignmentId: receipt.assignmentId,
    executionId: row.turnToken!,
    prompt: "cancelled continuation".padEnd(LIMITS.messageLength, "x"),
  });
  for (let i = 0; i < HOST_LIMITS.notesPending.max; i++)
    await owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "cancelled advice".padEnd(LIMITS.noteLength, "x"),
      from: "critic",
    });
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  await send(t, receipt.threadId, "fresh request after staged continuation");
  await owner(t).mutation(api.agents.note, {
    threadId: receipt.threadId,
    text: "fresh advice",
    from: "critic",
  });
  await drain(t);
  expect(calls()).toHaveLength(1);
  const prompt = JSON.stringify(calls()[0].args.prompt);
  expect(prompt).toContain("fresh request after staged continuation");
  expect(prompt.match(/fresh advice/g)).toHaveLength(1);
  expect(prompt).not.toContain("cancelled continuation");
  expect(prompt).not.toContain("cancelled advice");
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
      approved,
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
