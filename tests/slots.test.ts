// @vitest-environment edge-runtime
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { storeFile } from "@convex-dev/agent";
import { tool } from "ai";
import { z } from "zod";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { fixture, reset, exports, api, registration, text, call, main } from "./hooks.host.js";
import { components, rawAssignment } from "./fixture/api.js";
import { requireReceipt } from "./receipt.js";
import { LIMITS, registerAgent } from "../src/client/index.js";
import { scopedMeter } from "../src/client/slots.js";
import type { SlotFacts, MeterBackend, MeterChargeBackend } from "../src/client/slots.js";
import { HOST_LIMITS, type Limits } from "../src/component/limits.js";
const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

function setup(limits?: Partial<Limits>) {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: { ...modules, "./fixture/agents.ts": async () => exports(limits) },
  });

  agent.register(t);
  agevex.register(t);

  return t;
}
type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });

const open = (t: Test, files?: string[]) =>
  owner(t)
    .mutation(api.agents.open, {
      agent: "Main",
      prompt: "hello",
      requestKey: "first",
      ...(files ? { files } : {}),
    })
    .then(requireReceipt);

const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
const status = (t: Test, threadId: string) => owner(t).query(api.agents.activity, { threadId });

const transcript = (t: Test, threadId: string) =>
  owner(t).query(api.agents.messages, {
    threadId,
    paginationOpts: { cursor: null, numItems: 100 },
  });

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

function meter() {
  const scopes: SlotFacts[] = [];
  const operations: { op: string; provider?: string; args: Record<string, unknown> }[] = [];

  const handle = (key: string): MeterChargeBackend => ({
    key,
    attach: async (args) => {
      operations.push({ op: "attach", args });
    },
    correct: async (args) => {
      operations.push({ op: "correct", args });
    },
    settle: async (args) => {
      operations.push({ op: "settle", args });
    },
    get: async () => null,
  });

  const backend: MeterBackend = {
    estimate: async (provider, args) => {
      operations.push({ op: "estimate", provider, args });

      return handle(args.key);
    },
    record: async (provider, args) => {
      operations.push({ op: "record", provider, args });

      return handle(args.key);
    },
  };

  return {
    scopes,
    operations,
    slot: {
      scope: (_ctx: unknown, facts: SlotFacts) => {
        scopes.push(facts);

        return backend;
      },
    },
  };
}
async function upload(t: Test, subject = "alice", content = "file text") {
  const file = await t.action(
    async (ctx) =>
      (
        await storeFile(ctx, components.agent, new Blob([content], { type: "text/plain" }), {
          filename: "test.txt",
        })
      ).file,
  );

  await t.mutation((ctx) =>
    registration().registerFile(ctx, { agent: "Main", fileId: file.fileId, subject }),
  );

  return file.fileId;
}

beforeEach(() => {
  reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["managed", "metered_once"])(
  "%s receives attributed meter and stable default charge/operation keys",
  async (name) => {
    const usage = meter();

    fixture.slots.usage = usage.slot;
    fixture.steps.Main = (n) => (n === 0 ? call(name, {}) : text("finished"));

    fixture.toolWork = async (tc) => {
      const charge = await tc.meter.estimate("paid", { quantity: 1 });

      await charge.attach({ requestId: "request" });
      await charge.correct({ quantity: 2 });
      await charge.settle({ usd: 0.01 });
      await tc.meter.record("paid", {});

      return "done";
    };

    const t = setup();
    const receipt = await open(t);

    await drain(t);
    const tc = fixture.toolContext!;

    expect(tc).toMatchObject({
      subject: "alice",
      rootThreadId: receipt.threadId,
      threadId: receipt.threadId,
      agent: "Main",
    });

    expect(usage.scopes).toContainEqual({
      subject: "alice",
      rootThreadId: receipt.threadId,
      threadId: receipt.threadId,
      runId: tc.runId,
      agent: "Main",
    });

    const operations = usage.operations.filter(
      (op) => op.provider === "paid" || ["attach", "correct", "settle"].includes(op.op),
    );

    const keys = operations.map((op) => op.args.key);

    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);

    for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/);

    expect((await status(t, receipt.threadId)).errorCode).toBeNull();
  },
);

it("managed tools receive a no-op meter when no usage slot is registered", async () => {
  fixture.steps.Main = (n) => (n === 0 ? call("managed", {}) : text("finished"));

  fixture.toolWork = async (tc) => {
    const c = await tc.meter.record("anything", {});

    await c.attach({ requestId: "r" });
    await c.correct({ quantity: 1 });
    await c.settle({ credits: 2 });

    return "done";
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(fixture.toolContext?.subject).toBe("alice");
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
});

it("each saved model step records one exact-id charge and replay records none", async () => {
  const usage = meter();

  fixture.slots.usage = usage.slot;
  fixture.steps.Main = (n) => (n === 0 ? call("managed", {}) : text("finished"));
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(usage.operations).toHaveLength(2);

  expect(usage.scopes.some((facts) => "model" in facts && typeof facts.model === "string")).toBe(
    true,
  );

  expect(usage.operations[0].args.key).toMatch(/^[a-f0-9]{64}$/);
  expect(new Set(usage.operations.map((op) => op.args.key)).size).toBe(2);

  const execution = (await t.query(rawAssignment, {
    assignmentId: receipt.assignmentId,
  }))!;

  await t.action(api.agents.runTurn, {
    assignmentId: receipt.assignmentId,
    turnToken: execution.turnToken ?? "stale",
    sliceId: "replay",
  });

  await owner(t).mutation(api.agents.open, { agent: "Main", prompt: "hello", requestKey: "first" });
  await drain(t);
  expect(usage.operations).toHaveLength(2);
});

it("usage recording failure preserves a successful paid turn", async () => {
  fixture.slots.usage = {
    scope: () => ({
      ...meter().slot.scope({}, {} as SlotFacts),
      record: async () => {
        throw new Error("unavailable");
      },
    }),
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
  expect(fixture.calls).toHaveLength(1);
});

it.each([0, HOST_LIMITS.notesPending.max])(
  "budget denial retains its typed error and pending notes with %s notes already admitted",
  async (pending) => {
    const denial = gate();
    let checks = 0;
    let checkedRun = "";

    fixture.slots.budget = {
      check: async (_ctx, args) => {
        expect(args.subject).toBe("alice");
        expect(args.runId).toBeTruthy();
        checkedRun = args.runId;

        if (checks++ === 0) return { allowed: true };

        await denial.promise;

        return { allowed: false };
      },
    };

    fixture.steps.Main = () => call("managed", {});
    const t = setup({ notesPending: HOST_LIMITS.notesPending.max });
    const receipt = await open(t);

    await waitFor(t, () => checks === 2);

    for (let n = 0; n < pending; n++)
      await owner(t).mutation(api.agents.note, {
        threadId: receipt.threadId,
        text: `preserved note ${n}`,
        from: "host",
      });

    denial.release();
    await drain(t);
    expect(fixture.calls).toHaveLength(1);
    expect(checks).toBe(2);

    // Activity names the exact stopped run the budget check saw, so a host can
    // key its recovery (cancel + fresh send) to that run.
    expect(await status(t, receipt.threadId)).toMatchObject({
      errorCode: "BUDGET_EXCEEDED",
      turnStatus: "recovery_required",
      runId: checkedRun,
    });

    expect(
      (await transcript(t, receipt.threadId)).page.filter((message) => message.origin === "note"),
    ).toHaveLength(0);

    expect((await status(t, receipt.threadId)).queuedMessages).toBe(0);

    if (pending)
      await expect(
        owner(t).mutation(api.agents.note, {
          threadId: receipt.threadId,
          text: "over cap",
          from: "host",
        }),
      ).rejects.toMatchObject({ data: { code: "NOTES_PENDING_LIMIT" } });
  },
);

it.each([false, true])(
  "telemetry receives turn facts and flushes even when generation fails=%s",
  async (fails) => {
    const facts: (SlotFacts & { turnKey: string })[] = [];
    let flushes = 0;
    let starts = 0;

    fixture.slots.telemetry = {
      integration: (value) => {
        facts.push(value);

        return {
          onStart: () => {
            starts++;
          },
        };
      },
      flush: async () => {
        flushes++;
      },
    };

    if (fails)
      fixture.steps.Main = () => {
        throw new Error("provider unavailable");
      };

    const t = setup();
    const receipt = await open(t);

    await drain(t);
    expect(facts).toHaveLength(1);

    expect(facts[0]).toMatchObject({
      subject: "alice",
      rootThreadId: receipt.threadId,
      threadId: receipt.threadId,
      agent: "Main",
    });

    expect(facts[0].turnKey).toBeTruthy();
    expect(flushes).toBe(1);

    if (!fails) expect(starts).toBe(1);
  },
);

it("telemetry integration and flush failures cannot fail the turn", async () => {
  fixture.slots.telemetry = {
    integration: () => {
      throw new Error("bad exporter");
    },
    flush: async () => {
      throw new Error("bad flush");
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
});

it("an uncooperative telemetry flush cannot hold an action longer than three seconds", async () => {
  fixture.slots.telemetry = { integration: () => ({}), flush: () => new Promise(() => {}) };
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
});

it.each([false, true])(
  "sandbox tools are offered only to opted-in agents (%s)",
  async (enabled) => {
    fixture.sandbox = enabled;
    const bound: unknown[] = [];

    fixture.slots.sandbox = {
      tools: (tc) => {
        bound.push(tc);

        return { sandbox_exec: tool({ inputSchema: z.object({}), execute: () => "ok" }) };
      },
    };

    const t = setup();
    const receipt = await open(t);

    await drain(t);
    const offered = fixture.calls[0].args.tools?.map((tool) => tool.name) ?? [];

    expect(offered.includes("sandbox_exec")).toBe(enabled);
    expect(bound).toHaveLength(enabled ? 1 : 0);

    if (enabled)
      expect(bound[0]).toMatchObject({
        subject: "alice",
        threadId: receipt.threadId,
        rootThreadId: receipt.threadId,
        agent: "Main",
      });
  },
);

it("sandbox job completion posts a bounded passive note through the F1 path", async () => {
  fixture.sandbox = true;
  fixture.slots.sandbox = { tools: () => ({}) };
  const t = setup();
  const receipt = await open(t);

  await drain(t);

  await t.mutation((ctx) =>
    registration().sandboxComplete(ctx, {
      subject: "alice",
      threadId: receipt.threadId,
      runId: "run",
      jobId: "job",
      state: "done",
      exitCode: 0,
      logTail: "x".repeat(LIMITS.noteLength * 2),
    }),
  );

  await drain(t);
  expect(fixture.calls).toHaveLength(1);

  expect(
    (await transcript(t, receipt.threadId)).page.filter((message) => message.origin === "note"),
  ).toHaveLength(0);

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "inspect job",
    requestKey: "inspect",
  });

  await drain(t);
  expect(JSON.stringify(fixture.calls[1].args.prompt).match(/Job job: done/g)).toHaveLength(1);

  const notes = (await transcript(t, receipt.threadId)).page.filter(
    (message) => message.origin === "note",
  );

  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ from: "sandbox", role: "user", status: "success" });
  expect(notes[0].text).toContain("Job job: done (exit 0)");
  expect(notes[0].text).toHaveLength(LIMITS.noteLength + '<note from="sandbox"></note>'.length);
  expect((await status(t, receipt.threadId)).queuedMessages).toBe(0);
});

it("sandbox completions reach a root whose own agent never opted into sandbox tools", async () => {
  // A child agent may own the sandbox work; the root conversation still gets the note.
  fixture.sandbox = false;
  fixture.slots.sandbox = { tools: () => ({}) };
  const t = setup();
  const receipt = await open(t);

  await drain(t);

  expect(
    await t.mutation((ctx) =>
      registration().sandboxComplete(ctx, {
        subject: "alice",
        threadId: receipt.threadId,
        runId: "run",
        jobId: "child-job",
        state: "done",
      }),
    ),
  ).toBe(true);

  await expect(
    t.mutation((ctx) =>
      registration().sandboxComplete(ctx, {
        subject: "bob",
        threadId: receipt.threadId,
        runId: "run",
        jobId: "foreign",
        state: "done",
      }),
    ),
  ).rejects.toThrow("FORBIDDEN");
});

it("once tools offer their declared description to the model", async () => {
  const t = setup();

  await open(t);
  await drain(t);
  const effect = fixture.calls[0].args.tools?.find((tool) => tool.name === "once");

  expect(effect).toMatchObject({ description: "Echo text exactly once." });
});

it.each(["idle", "in-flight"])(
  "%s sandbox completions share the host note cap and retain provenance until the next safe claim",
  async (arrival) => {
    fixture.sandbox = true;
    fixture.slots.sandbox = { tools: () => ({}) };
    const held = gate();

    fixture.steps.Main = async (n) => {
      if (arrival === "in-flight" && n === 0) {
        await held.promise;

        return call("managed", {});
      }

      return text("done");
    };

    const t = setup({ notesPending: 2, queueLength: 1 });
    const receipt = await open(t);

    if (arrival === "idle") await drain(t);
    else {
      await waitFor(t, () => fixture.calls.length === 1);

      await owner(t).mutation(api.agents.send, {
        threadId: receipt.threadId,
        text: "future request",
        requestKey: "future",
      });
    }

    await owner(t).mutation(api.agents.note, {
      threadId: receipt.threadId,
      text: "host advice",
      from: "host",
    });

    const complete = (jobId: string) =>
      t.mutation((ctx) =>
        registration().sandboxComplete(ctx, {
          subject: "alice",
          threadId: receipt.threadId,
          runId: "run",
          jobId,
          state: "done",
        }),
      );

    expect(await complete("admitted")).toBe(true);

    const early = (await transcript(t, receipt.threadId)).page.filter(
      (message) => message.origin === "note",
    );

    expect(early).toHaveLength(0);

    await expect(complete("over cap")).rejects.toMatchObject({
      data: { code: "NOTES_PENDING_LIMIT" },
    });

    if (arrival === "idle")
      await owner(t).mutation(api.agents.send, {
        threadId: receipt.threadId,
        text: "next request",
        requestKey: "next",
      });

    held.release();
    await drain(t);

    const notes = (await transcript(t, receipt.threadId)).page.filter(
      (message) => message.origin === "note",
    );

    expect(notes).toHaveLength(2);
    expect(notes.map((message) => message.from).sort()).toEqual(["host", "sandbox"]);
    expect(notes.every((message) => message.status === "success")).toBe(true);

    if (arrival === "in-flight") {
      // An ordinary tool-step slice belongs to the current turn, so neither
      // note may appear until the queued user request claims a new turn.
      expect(JSON.stringify(fixture.calls[1].args.prompt)).not.toContain("host advice");
      expect(JSON.stringify(fixture.calls[1].args.prompt)).not.toContain("Job admitted");
    }

    const prompt = JSON.stringify(fixture.calls[arrival === "idle" ? 1 : 2].args.prompt);

    expect(prompt.match(/Job admitted: done/g)).toHaveLength(1);
    expect(prompt.match(/host advice/g)).toHaveLength(1);
    expect(prompt).toContain(arrival === "idle" ? "next request" : "future request");
    expect((await status(t, receipt.threadId)).queuedMessages).toBe(0);
    expect(await complete("capacity reused")).toBe(true);

    expect(
      (await transcript(t, receipt.threadId)).page.filter((message) => message.from === "sandbox"),
    ).toHaveLength(1);

    await owner(t).mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "inspect reused capacity",
      requestKey: "reused",
    });

    await drain(t);

    const delivered = (await transcript(t, receipt.threadId)).page.filter(
      (message) => message.origin === "note",
    );

    expect(delivered).toHaveLength(3);
    expect(delivered.filter((message) => message.from === "sandbox")).toHaveLength(2);
    expect(delivered.filter((message) => message.text.includes("Job admitted:"))).toHaveLength(1);

    expect(
      delivered.filter((message) => message.text.includes("Job capacity reused:")),
    ).toHaveLength(1);
  },
);

it("open and send reject another subject's files before saving a native attachment", async () => {
  const t = setup();
  const foreign = await upload(t, "bob");

  await expect(open(t, [foreign])).rejects.toThrow("FILE_FORBIDDEN");
  const receipt = await open(t);

  await drain(t);

  await expect(
    owner(t).mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "foreign",
      files: [foreign],
      requestKey: "foreign",
    }),
  ).rejects.toThrow("FILE_FORBIDDEN");

  expect(JSON.stringify((await transcript(t, receipt.threadId)).page)).not.toContain("foreign");
});

it("each attached file starts extraction and file tools are bound to the owned thread", async () => {
  const admitted: { fileId: string; threadId: string }[] = [];
  const bound: unknown[] = [];

  fixture.slots.extract = {
    run: async (_ctx, args) => {
      admitted.push(args);
    },
    tools: (tc) => {
      bound.push(tc);

      return {
        read_file: tool({ inputSchema: z.object({}), execute: () => "text" }),
        search_files: tool({ inputSchema: z.object({}), execute: () => [] }),
      };
    },
  };

  const t = setup();
  const files: string[] = [];

  for (let n = 0; n < LIMITS.filesPerMessage; n++)
    files.push(await upload(t, "alice", `extract ${n}`));

  const receipt = await open(t, files);

  await drain(t);

  expect(admitted).toEqual(
    files.map((fileId) => ({ fileId, threadId: receipt.threadId, subject: "alice" })),
  );

  expect(bound[0]).toMatchObject({ threadId: receipt.threadId, subject: "alice" });
  expect(JSON.stringify(fixture.calls[0].args.prompt)).toContain("Attached files");

  expect(
    fixture.calls[0].args.prompt.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === "file"),
    ),
  ).toBe(false);

  for (const fileId of files)
    expect(
      await t.query((ctx) =>
        registration().fileAttached(ctx, { threadId: receipt.threadId, subject: "alice", fileId }),
      ),
    ).toBe(true);
});

it("one message never binds more than filesPerMessage attachments, so forMessage returns every bound file", async () => {
  const t = setup();
  const native = "native-files";
  const fileIds = Array.from({ length: LIMITS.filesPerMessage + 1 }, (_, n) => `file-${n}`);

  for (const fileId of fileIds)
    await t.mutation(components.agevex.files.attachments.register, {
      native,
      fileId,
      subject: "alice",
    });

  const message = { native, subject: "alice", threadId: "thread", messageId: "message" };
  const bound = fileIds.slice(0, LIMITS.filesPerMessage);

  await t.mutation(components.agevex.files.attachments.attach, { ...message, files: bound });

  // A second host call for the same message cannot push it past the cap that
  // attach's dedup read and forMessage's bounded read both rely on.
  await expect(
    t.mutation(components.agevex.files.attachments.attach, {
      ...message,
      files: fileIds.slice(LIMITS.filesPerMessage),
    }),
  ).rejects.toThrow("FILE_LIMIT");

  // Re-binding an already bound file stays an idempotent no-op at the cap.
  await t.mutation(components.agevex.files.attachments.attach, { ...message, files: [bound[0]] });

  expect((await t.query(components.agevex.files.attachments.forMessage, message)).sort()).toEqual(
    [...bound].sort(),
  );
});

it("without extract the hard maximum of attachments reaches the model as native file parts", async () => {
  const t = setup();
  const files = [];

  for (let n = 0; n < LIMITS.filesPerMessage; n++)
    files.push(await upload(t, "alice", `file ${n}`));

  const receipt = await open(t, files);

  await drain(t);

  const count = fixture.calls[0].args.prompt.reduce(
    (n, message) =>
      n +
      (Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "file").length
        : 0),
    0,
  );

  expect(count).toBe(LIMITS.filesPerMessage);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();

  await expect(
    owner(t).mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "too many",
      requestKey: "too many",
      files: [...files, "extra"],
    }),
  ).rejects.toThrow("INVALID_FILES");
});

it("child model usage retains the root thread and shared user-run attribution", async () => {
  const usage = meter();

  fixture.slots.usage = usage.slot;

  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "one task" }) : text("done");

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const root = usage.scopes.find((facts) => facts.agent === "Main")!;
  const child = usage.scopes.find((facts) => facts.agent === "Builder")!;

  expect(child).toMatchObject({
    subject: "alice",
    rootThreadId: receipt.threadId,
    runId: root.runId,
  });

  expect(child.threadId).not.toBe(receipt.threadId);
});

it("concurrent telemetry actions flush their own turn facts", async () => {
  const opened: string[] = [];
  const closed: string[] = [];

  fixture.slots.telemetry = {
    integration: (facts) => {
      opened.push(facts.turnKey);

      return {};
    },
    flush: async (facts) => {
      closed.push(facts.turnKey);
    },
  };

  const t = setup();

  await open(t);

  await owner(t).mutation(api.agents.open, {
    agent: "Main",
    prompt: "second",
    requestKey: "second",
  });

  await drain(t);
  expect(new Set(opened).size).toBe(2);
  expect(closed.sort()).toEqual(opened.sort());
});

it.each(["admitted", "full before claim", "full during denial"])(
  "budget notes deliver once at the next result claim with the backlog %s",
  async (backlog) => {
    const continuation = gate();
    const denial = gate();
    const descendant = gate();
    let continuing = false;
    let denyNext = false;
    let checking = false;

    fixture.builderHooks.afterTurn = async (_hc, event) => {
      if (event.turn !== 1) return;

      continuing = true;
      await continuation.promise;
      denyNext = true;

      return { continue: "inspect while helper runs" };
    };

    fixture.slots.budget = {
      check: async () => {
        if (!denyNext) return { allowed: true };

        denyNext = false;
        checking = true;
        await denial.promise;

        return { allowed: false };
      },
    };

    fixture.steps.Main = (n) =>
      n === 0
        ? call("agevex_delegate", { agent: "Builder", task: "build with a helper" })
        : text("root done");

    fixture.steps.Builder = (n) =>
      n === 0
        ? call("agevex_delegate", { agent: "Critic", task: "check the work" })
        : text("recovered from helper result");

    fixture.steps.Critic = async () => {
      await descendant.promise;

      return text("helper result");
    };

    const t = setup({ notesPending: HOST_LIMITS.notesPending.max });
    const receipt = await open(t);

    await waitFor(t, () => continuing && fixture.calls.some((call) => call.agent === "Critic"));

    const builderRun = (
      await owner(t).query(api.agents.runTree, { threadId: receipt.threadId })
    ).find((run) => run.agent === "Builder")!;

    const threadId = builderRun.childThreadId!;

    if (backlog !== "full before claim") {
      continuation.release();
      await waitFor(t, () => checking);
    }

    if (backlog !== "admitted")
      for (let n = 0; n < HOST_LIMITS.notesPending.max; n++)
        await owner(t).mutation(api.agents.note, {
          threadId,
          text: `note ${n}` + '"'.repeat(LIMITS.noteLength - `note ${n}`.length),
          from: "host",
        });

    continuation.release();
    await waitFor(t, () => checking);
    denial.release();

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

    expect(fixture.calls.filter((call) => call.agent === "Builder")).toHaveLength(1);

    const early = (await transcript(t, threadId)).page.filter(
      (message) => message.origin === "note",
    );

    expect(early.every((message) => message.from === "host")).toBe(true);

    if (backlog !== "full before claim") expect(early).toHaveLength(0);

    if (backlog === "full during denial")
      await expect(
        owner(t).mutation(api.agents.note, {
          threadId,
          text: "over cap",
          from: "host",
        }),
      ).rejects.toMatchObject({ data: { code: "NOTES_PENDING_LIMIT" } });

    descendant.release();
    await drain(t);

    const prompt = JSON.stringify(
      fixture.calls.filter((call) => call.agent === "Builder")[1].args.prompt,
    );

    const budgetNotes = backlog === "full during denial" ? 0 : 1;

    expect(prompt.match(/BUDGET_EXCEEDED/g) ?? []).toHaveLength(budgetNotes);
    // The maximum escaped backlog exceeds one byte-limited transcript page.
    let cursor: string | null = null;
    const delivered: { id: string; from?: string; text: string }[] = [];

    for (;;) {
      const page: Awaited<ReturnType<typeof transcript>> = await owner(t).query(
        api.agents.messages,
        {
          threadId,
          paginationOpts: { cursor, numItems: 100 },
        },
      );

      const notes = page.page.filter(
        (message) =>
          message.origin === "note" && (message.from === "host" || message.from === "budget"),
      );

      expect(
        notes.every((message) => message.role === "user" && message.status === "success"),
      ).toBe(true);

      delivered.push(...notes);

      if (page.isDone) break;

      cursor = page.continueCursor;
    }

    const hostNotes = backlog === "admitted" ? 0 : HOST_LIMITS.notesPending.max;

    expect(delivered).toHaveLength(hostNotes + budgetNotes);
    expect(new Set(delivered.map((message) => message.id)).size).toBe(delivered.length);
    expect(delivered.filter((message) => message.from === "budget")).toHaveLength(budgetNotes);
    expect(delivered.filter((message) => message.from === "host")).toHaveLength(hostNotes);

    for (let n = 0; n < hostNotes; n++)
      expect(delivered.filter((message) => message.text.includes(`note ${n}&quot;`))).toHaveLength(
        1,
      );

    // Only a safe claim frees capacity; denial never drains or displaces notes.
    expect(
      await owner(t).mutation(api.agents.note, {
        threadId,
        text: "capacity reused",
        from: "host",
      }),
    ).toBe(true);
  },
);

it("upload ownership survives effect receipt cleanup without keeping purge work alive", async () => {
  const t = setup();
  const fileId = await upload(t);
  const args = { scope: "expired-effect", key: "effect", fingerprint: "effect" };
  const claim = await t.mutation(components.agevex.receipts.effects.begin, args);

  if (claim.status !== "claimed") throw new Error("EXPECTED_CLAIM");

  await t.mutation(components.agevex.receipts.effects.complete, {
    scope: args.scope,
    key: args.key,
    claim: claim.claim,
    result: null,
  });

  vi.advanceTimersByTime(LIMITS.receiptRetentionMs + 1);
  await drain(t);
  const receipt = await open(t, [fileId]);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
  expect(fixture.calls).toHaveLength(1);
});

it.each(["x".repeat(129), "😀".repeat(100)])(
  "rejects oversized UTF-8 subjects before admission (%s)",
  async (subject) => {
    const t = setup();

    await expect(
      t
        .withIdentity({ subject })
        .mutation(api.agents.open, { agent: "Main", prompt: "hello", requestKey: "invalid" }),
    ).rejects.toThrow("INVALID_SUBJECT");

    expect(fixture.calls).toHaveLength(0);
  },
);

it.each(["x".repeat(129), "😀".repeat(100)])(
  "rejects oversized UTF-8 agent names at registration (%s)",
  (name) => {
    expect(() =>
      registerAgent(components.agevex, {
        agents: [Object.create(main, { name: { value: name } }) as typeof main],
        refs: { runTurn: () => api.agents.runTurn },
        authorize: async () => ({ subject: "alice" }),
        authorizeExecution: async () => {},
      }),
    ).toThrow("INVALID_AGENT");
  },
);

it.each(["x".repeat(250), "id:delta:reserved"])(
  "opaque charge and operation keys are bounded and replay stable (%s)",
  async (id) => {
    const usage = meter();

    const invoke = async () => {
      const scoped = scopedMeter(usage.slot.scope({}, {} as SlotFacts), id);
      const c = await scoped.estimate("paid", { quantity: 1 });

      await c.attach({ requestId: "original" });
      await c.correct({ quantity: 2 });
      await c.settle({ usd: 1 });
      await scoped.record("paid", { key: id });
    };

    await invoke();
    await invoke();
    const keys = usage.operations.map((op) => op.args.key);

    expect(keys.slice(0, 5)).toEqual(keys.slice(5));

    for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/);

    expect(new Set(keys.slice(0, 5)).size).toBe(5);
  },
);

it.each(["x".repeat(250), "id:delta:reserved"])(
  "once tools accept long/reserved ids and retain native attribution (%s)",
  async (id) => {
    fixture.steps.Main = (n) =>
      n === 0
        ? [{ type: "tool-call", toolName: "metered_once", toolCallId: id, input: "{}" }]
        : text("finished");

    const t = setup();
    const r = await open(t);

    await drain(t);
    expect(fixture.toolContext).toMatchObject({ nativeToolCallId: id });
    expect(fixture.toolContext?.toolCallId).toMatch(/^[a-f0-9]{64}$/);
    expect((await status(t, r.threadId)).errorCode).toBeNull();
  },
);

it.each(["open", "send"])(
  "%s rejects total storage bytes over the message budget with a typed receipt",
  async (operation) => {
    const t = setup();

    const files = [
      await upload(t, "alice", "a".repeat(5 << 20)),
      await upload(t, "alice", "b".repeat(5 << 20)),
    ];

    let result;

    if (operation === "open")
      result = await owner(t).mutation(api.agents.open, {
        agent: "Main",
        prompt: "large",
        requestKey: "large",
        files,
      });
    else {
      const r = await open(t);

      await drain(t);

      result = await owner(t).mutation(api.agents.send, {
        threadId: r.threadId,
        text: "large",
        requestKey: "large",
        files,
      });
    }

    expect(result).toEqual({ status: "rejected", code: "ATTACHMENT_LIMIT" });
  },
);

it.each([false, true])(
  "native downloads enforce the generation budget including history (%s)",
  async (over) => {
    fixture.supportsUrls = false;
    const t = setup();
    const size = 5 << 20;

    const files = [
      await upload(t, "alice", "a".repeat(size)),
      await upload(t, "alice", "b".repeat(size)),
    ];

    let downloads = 0;
    let readBytes = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        downloads++;
        let left = size;

        return new Response(
          new ReadableStream({
            pull(c) {
              if (!left) {
                c.close();

                return;
              }

              const n = Math.min(left, 64 << 10);

              left -= n;
              readBytes += n;
              c.enqueue(new Uint8Array(n));
            },
          }),
          { headers: { "content-type": "text/plain" } },
        );
      }),
    );

    try {
      const r = await open(t, [files[0]]);

      await drain(t);
      expect((await status(t, r.threadId)).errorCode).toBeNull();
      expect(downloads).toBe(1);

      const message = fixture.calls[0].args.prompt.find(
        (m) => m.role === "user" && Array.isArray(m.content),
      );

      const part =
        message && message.role === "user"
          ? message.content.find((p) => p.type === "file")
          : undefined;

      expect(
        part?.type === "file" &&
          part.data.type === "data" &&
          part.data.data instanceof Uint8Array &&
          part.data.data.byteLength,
      ).toBe(size);

      if (over) {
        const before = readBytes;

        await owner(t).mutation(api.agents.send, {
          threadId: r.threadId,
          text: "second",
          requestKey: "second",
          files: [files[1]],
        });

        await drain(t);
        expect((await status(t, r.threadId)).errorCode).toBe("GENERATION_FAILED");
        expect(fixture.calls).toHaveLength(1);
        expect(readBytes - before).toBeLessThan(size * 2);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("native downloads stop oversized responses while streaming despite small metadata", async () => {
  fixture.supportsUrls = false;
  const t = setup();
  const file = await upload(t);
  let read = 0;
  let cancelled = false;

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      let left = 10 << 20;

      return new Response(
        new ReadableStream({
          pull(c) {
            if (!left) {
              c.close();

              return;
            }

            left -= 64 << 10;
            read += 64 << 10;
            c.enqueue(new Uint8Array(64 << 10));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }),
  );

  try {
    const r = await open(t, [file]);

    await drain(t);
    expect((await status(t, r.threadId)).errorCode).toBe("GENERATION_FAILED");
    expect(fixture.calls).toHaveLength(0);
    expect(cancelled).toBe(true);
    expect(read).toBeLessThan(10 << 20);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("the hard maximum attachment budget admits eight files by actual storage and downloaded bytes", async () => {
  fixture.supportsUrls = false;
  const t = setup({ attachmentBytes: HOST_LIMITS.attachmentBytes.max });
  const size = HOST_LIMITS.attachmentBytes.max / LIMITS.filesPerMessage;
  const files = [];

  for (let n = 0; n < LIMITS.filesPerMessage; n++)
    files.push(await upload(t, "alice", String(n).repeat(size)));

  let downloaded = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      downloaded += size;

      return new Response(new Uint8Array(size), { headers: { "content-type": "text/plain" } });
    }),
  );

  try {
    const r = await open(t, files);

    await drain(t);
    expect((await status(t, r.threadId)).errorCode).toBeNull();
    expect(downloaded).toBe(HOST_LIMITS.attachmentBytes.max);
    expect(fixture.calls).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("registration rejects attachment budgets above the hard maximum", () => {
  expect(() => registration({ attachmentBytes: HOST_LIMITS.attachmentBytes.max + 1 })).toThrow(
    "INVALID_LIMITS",
  );
});

it("public thread ids reject oversized UTF-8 facts with typed errors", async () => {
  const t = setup();

  await expect(
    owner(t).mutation(api.agents.send, {
      threadId: "😀".repeat(40),
      text: "hello",
      requestKey: "invalid",
    }),
  ).rejects.toThrow("INVALID_THREADID");
});
