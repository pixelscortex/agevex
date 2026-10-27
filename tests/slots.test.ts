// @vitest-environment edge-runtime
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { storeFile } from "@convex-dev/agent";
import { tool } from "ai";
import { telemetry } from "../src/modules/telemetry/client/index.js";
import { z } from "zod";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import { fixture, reset, exports, api, registration, text, call, main } from "./hooks.host.js";
import { components, rawAssignment } from "./fixture/api.js";
import { requireReceipt } from "./receipt.js";
import { LIMITS } from "../src/component/limits.js";
import { registerAgent } from "../src/client/index.js";
import type { UsageEvent, UsageSlot, SlotFacts } from "../src/client/slots.js";
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

it("each saved model step records one exact-id usage event and replay records none", async () => {
  const usage = usageRecorder();

  fixture.generationIds = true;
  fixture.slots.usage = usage.slot;
  fixture.steps.Main = (n) => (n === 0 ? call("managed", {}) : text("finished"));
  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect(usage.events).toHaveLength(2);

  for (const event of usage.events) {
    expect(event.messageId).toBeTruthy();

    const [native] = await t.query(components.agent.messages.getMessagesByIds, {
      messageIds: [event.messageId!],
    });

    expect(event.usage).toEqual(native!.usage);
    expect(event.requestId).toBeTruthy();
  }

  expect(usage.events.some((facts) => "model" in facts && typeof facts.model === "string")).toBe(
    true,
  );

  expect(usage.events[0].key).toMatch(/^[a-f0-9]{64}$/);
  expect(new Set(usage.events.map((op) => op.key)).size).toBe(2);

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
  expect(usage.events).toHaveLength(2);
});

it("usage recording failure preserves a successful paid turn", async () => {
  fixture.slots.usage = {
    record: async () => {
      throw new Error("unavailable");
    },
  };

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
  expect(fixture.calls).toHaveLength(1);
  const runId = (await status(t, receipt.threadId)).runId!;

  expect(await t.query(components.agevex.turns.slices.usageReporting, { runId })).toBe(true);
});

it.each([0, HOST_LIMITS.notesPending.max])(
  "budget denial retains its typed error and pending notes with %s notes already admitted",
  async (pending) => {
    const denial = gate();
    let refusing = false;
    let checkedRun = "";

    fixture.slots.budget = {
      check: async (_ctx, args) => {
        expect(args.subject).toBe("alice");
        expect(args.runId).toBeTruthy();
        checkedRun = args.runId;

        if (fixture.calls.length === 0) return { allowed: true };

        refusing = true;

        await denial.promise;

        return { allowed: false };
      },
    };

    fixture.steps.Main = () => call("managed", {});
    const t = setup({ notesPending: HOST_LIMITS.notesPending.max });
    const receipt = await open(t);

    await waitFor(t, () => refusing);

    for (let n = 0; n < pending; n++)
      await owner(t).mutation(api.agents.note, {
        threadId: receipt.threadId,
        text: `preserved note ${n}`,
        from: "host",
      });

    denial.release();
    await drain(t);
    expect(fixture.calls).toHaveLength(1);

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
  fixture.slots.telemetry = telemetry({ integration: {}, flush: () => new Promise(() => {}) });
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

it("the hard maximum of attachments reaches the model as native file parts", async () => {
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
  const usage = usageRecorder();

  fixture.slots.usage = usage.slot;

  fixture.steps.Main = (n) =>
    n === 0 ? call("agevex_delegate", { agent: "Builder", task: "one task" }) : text("done");

  const t = setup();
  const receipt = await open(t);

  await drain(t);
  const root = usage.events.find((facts) => facts.agent === "Main")!;
  const child = usage.events.find((facts) => facts.agent === "Builder")!;

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
        title: false,
        agents: [Object.create(main, { name: { value: name } }) as typeof main],
        refs: { runTurn: () => api.agents.runTurn },
        authorize: async () => ({ subject: "alice" }),
        authorizeExecution: async () => {},
      }),
    ).toThrow("INVALID_AGENT");
  },
);

it.each(["x".repeat(250), "id:delta:reserved"])(
  "once tools accept long/reserved ids and retain native attribution (%s)",
  async (id) => {
    fixture.steps.Main = (n) =>
      n === 0
        ? [{ type: "tool-call", toolName: "once_only", toolCallId: id, input: "{}" }]
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

/** Record the public callback facts without a second billing component. */
function usageRecorder() {
  const events: UsageEvent[] = [];

  const slot: UsageSlot = {
    record: async (_ctx, event) => {
      events.push(event);
    },
  };

  return { events, slot };
}
