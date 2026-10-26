// @vitest-environment edge-runtime
/** Promised progress delivery, bounded wakeups, ordering and execution fences. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HOST_LIMITS, LIMITS } from "../src/component/limits.js";
import { v2, call, delegate, text } from "./delegation-v2.host.js";
import {
  setup,
  open,
  owner,
  calls,
  drain,
  tree,
  transcript,
  waitFor,
  gate,
  sender,
  send,
  api,
  components,
  rawAssignment,
  evidence,
  hops,
  addHeadroomFixture,
} from "./message-parent.fixture.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("progress wakes a sleeping parent before the child result without pausing the child and records wake usage", async () => {
  const t = setup();
  const held = gate();

  v2.steps.Main = (n) => (n === 0 ? [delegate("Reviewer")] : text("read progress"));

  v2.steps.Reviewer = async (n) => {
    if (n === 0) return [call("agevex_message_parent", { text: "mid-work evidence" })];

    await held.promise;

    return text("final evidence");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Main").length === 2 && calls("Reviewer").length === 2);
  expect(JSON.stringify(calls("Main")[1].args.prompt)).toContain("mid-work evidence");
  expect(JSON.stringify(calls("Main")[1].args.prompt)).not.toContain("final evidence");
  expect((await tree(t, receipt.threadId))[0].status).toBe("running");
  await waitFor(t, () => evidence.filter((entry) => entry.facts.agent === "Main").length === 2);
  const usage = evidence.filter((entry) => entry.facts.agent === "Main");

  expect(usage[1].facts).toMatchObject({
    subject: "alice",
    threadId: receipt.threadId,
    purpose: "agent",
  });

  expect(usage[1].facts.runId).toBe(usage[0].facts.runId);
  expect(usage[1].key).not.toBe(usage[0].key);
  expect(usage[1].usage).toBeDefined();
  held.release();
  await drain(t);
  expect(calls("Main")).toHaveLength(3);
  const history = await transcript(t, receipt.threadId);

  expect(history.page.find((entry) => entry.text?.includes("mid-work evidence"))).toMatchObject({
    origin: "note",
    from: "Reviewer",
  });
});

it("a sleeping parent wakes once for a burst while rate denials and identical retries add no turns", async () => {
  const t = setup();
  const held = gate();

  v2.steps.Main = (n) =>
    n === 0 ? [delegate("Reviewer"), delegate("Reviewer")] : text("read burst");

  v2.steps.Reviewer = async () => {
    await held.promise;

    return text("final");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 2);
  const actor = await sender(t, receipt.threadId);
  const first = await send(t, actor, "burst first", "same-call");

  expect(first).toMatchObject({ status: "accepted" });
  expect(await send(t, actor, "burst first", "same-call")).toEqual(first);

  expect(await send(t, actor, "changed", "same-call")).toMatchObject({
    status: "denied",
    code: "KEY_CONFLICT",
  });

  expect(await send(t, actor, "burst excess")).toMatchObject({
    status: "denied",
    code: "MESSAGE_RATE_LIMIT",
  });

  expect(await send(t, await sender(t, receipt.threadId, 1), "burst sibling")).toMatchObject({
    status: "accepted",
  });

  await waitFor(t, () => calls("Main").length === 2);

  await waitFor(
    t,
    async () =>
      (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.turnStatus === "idle",
  );

  expect(calls("Main")).toHaveLength(2);
  expect(JSON.stringify(calls("Main")[1].args.prompt)).toContain("burst sibling");
  expect(JSON.stringify(await transcript(t, receipt.threadId))).not.toContain("burst excess");
  held.release();
  await drain(t);
  expect(calls("Main")).toHaveLength(3);
});

it.each([4, 8])(
  "chatter has finite cost: encoded size, five-second rate and %s accepted notes per child",
  async (cap) => {
    const maxima = Object.fromEntries(
      Object.entries(HOST_LIMITS).map(([key, value]) => [key, value.max]),
    );

    const t = setup({ ...maxima, parentNotesPerChild: cap });
    const held = gate();

    v2.steps.Main = (n) => (n === 0 ? [delegate("Reviewer")] : text("read progress"));

    v2.steps.Reviewer = async () => {
      await held.promise;

      return text("done");
    };

    const receipt = await open(t);

    await waitFor(t, () => calls("Reviewer").length === 1);
    const actor = await sender(t, receipt.threadId);

    for (const blank of ["", " \n\t"])
      expect(await send(t, actor, blank)).toMatchObject({
        status: "denied",
        code: "MESSAGE_EMPTY",
      });

    for (const oversized of [
      "a".repeat(LIMITS.parentNoteBytes),
      "😀".repeat(600),
      "x" + "\n".repeat(1100),
    ])
      expect(await send(t, actor, oversized)).toMatchObject({
        status: "denied",
        code: "MESSAGE_TOO_LARGE",
      });

    const exact = "a".repeat(LIMITS.parentNoteBytes - 2);
    const first = await send(t, actor, exact, "first");

    expect(first).toMatchObject({ status: "accepted" });

    expect(await send(t, actor, "too soon")).toMatchObject({
      status: "denied",
      code: "MESSAGE_RATE_LIMIT",
    });

    for (let i = 1; i < cap; i++) {
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
      });

      expect(await send(t, actor, `note ${i}`)).toEqual({
        status: "accepted",
        messageId: expect.any(String),
      });
    }

    await t.action(async () => {
      await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
    });

    expect(await send(t, actor, "excess count")).toMatchObject({
      status: "denied",
      code: "MESSAGE_LIMIT",
    });

    expect(await send(t, actor, exact, "first")).toEqual(first);
    const history = JSON.stringify(await transcript(t, receipt.threadId));

    expect(history).not.toContain("too soon");
    expect(history).not.toContain("excess count");
    held.release();
    await drain(t);
  },
);

it("messages and retries after the child finished are refused without reopening its parent", async () => {
  const t = setup();
  let actor: Awaited<ReturnType<typeof sender>>;
  const held = gate();

  v2.steps.Main = (n) => (n === 0 ? [delegate("Reviewer")] : text("read"));

  v2.steps.Reviewer = async () => {
    await held.promise;

    return text("done");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 1);
  actor = await sender(t, receipt.threadId);
  expect(await send(t, actor, "before final", "original")).toMatchObject({ status: "accepted" });
  held.release();
  await drain(t);
  const count = calls("Main").length;

  expect(await send(t, actor, "after final")).toMatchObject({ status: "denied" });
  expect(await send(t, actor, "before final", "original")).toMatchObject({ status: "denied" });
  await drain(t);
  expect(calls("Main")).toHaveLength(count);
  expect(JSON.stringify(await transcript(t, receipt.threadId))).not.toContain("after final");
});

it("cancellation fences late messages and retries while committed progress remains in history", async () => {
  const t = setup();
  const held = gate();

  v2.steps.Main = (n) => (n === 0 ? [delegate("Reviewer")] : text("read"));

  v2.steps.Reviewer = async () => {
    await held.promise;

    return text("late final");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 1);
  const actor = await sender(t, receipt.threadId);

  expect(await send(t, actor, "committed progress", "original")).toMatchObject({
    status: "accepted",
  });

  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

  expect(await send(t, actor, "late progress")).toMatchObject({
    status: "denied",
    code: "STALE_TURN",
  });

  expect(await send(t, actor, "committed progress", "original")).toMatchObject({
    status: "denied",
  });

  held.release();
  await drain(t);
  const page = await transcript(t, receipt.threadId);
  const history = JSON.stringify(page);

  expect(page.page.find((entry) => entry.text?.includes("committed progress"))).toMatchObject({
    origin: "note",
    from: "Reviewer",
  });

  expect(history).toContain("committed progress");
  expect(history).not.toContain("late progress");
  expect((await tree(t, receipt.threadId))[0].status).toBe("failed");
});

it.each(["queue", "hop"])(
  "the %s cap refuses fresh progress and replays accepted retries while final delivery always succeeds",
  async (cap) => {
    const t = setup(cap === "queue" ? { queueLength: 2 } : { runHops: 3 });
    const childHeld = gate();
    const parentHeld = gate();

    v2.steps.Main = async (n) => {
      if (n === 0) return [delegate("Reviewer")];

      await parentHeld.promise;

      return text("parent read");
    };

    v2.steps.Reviewer = async () => {
      await childHeld.promise;

      return text("reserved final result");
    };

    const receipt = await open(t);

    await waitFor(t, () => calls("Reviewer").length === 1);
    const actor = await sender(t, receipt.threadId);
    const first = await send(t, actor, "first", "first");

    expect(first).toMatchObject({ status: "accepted" });
    await waitFor(t, () => calls("Main").length === 2);

    await t.action(async () => {
      await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
    });

    if (cap === "queue") {
      expect(await send(t, actor, "queued")).toMatchObject({ status: "accepted" });

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
      });

      expect(await send(t, actor, "fills last message slot")).toMatchObject({ status: "accepted" });

      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
      });
    }

    expect(await send(t, actor, "denied by cap")).toMatchObject({
      status: "denied",
      code: cap === "queue" ? "QUEUE_LIMIT" : "RUN_BUDGET",
    });

    expect(await send(t, actor, "first", "first")).toEqual(first);
    expect(JSON.stringify(await transcript(t, receipt.threadId))).not.toContain("denied by cap");
    childHeld.release();

    await waitFor(t, async () =>
      JSON.stringify(await transcript(t, receipt.threadId)).includes("reserved final result"),
    );

    expect(await hops(t, receipt.assignmentId)).toBeLessThanOrEqual(
      cap === "hop" ? 3 : HOST_LIMITS.runHops.default,
    );

    expect(
      (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!.queuedMessages,
    ).toBeLessThanOrEqual(cap === "queue" ? 3 : HOST_LIMITS.queueLength.default);

    parentHeld.release();
    await drain(t);

    expect(JSON.stringify(calls("Main")[calls("Main").length - 1].args.prompt)).toContain(
      "reserved final result",
    );
  },
);

it("accepted progress precedes final delivery with stable FIFO coalescing and retry dedupe", async () => {
  const t = setup();
  const childHeld = gate();
  const parentHeld = gate();

  v2.steps.Main = async (n) => {
    if (n === 0) return [delegate("Reviewer")];

    if (n === 1) await parentHeld.promise;

    return text("parent read");
  };

  v2.steps.Reviewer = async () => {
    await childHeld.promise;

    return text("unique final marker");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 1);
  const actor = await sender(t, receipt.threadId);
  const first = await send(t, actor, "first progress marker", "first");

  await waitFor(t, () => calls("Main").length === 2);

  await t.action(async () => {
    await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
  });

  expect(await send(t, actor, "second progress marker")).toMatchObject({ status: "accepted" });
  expect(await send(t, actor, "first progress marker", "first")).toEqual(first);
  expect(JSON.stringify(calls("Main")[1].args.prompt)).not.toContain("second progress marker");
  childHeld.release();

  await waitFor(t, async () =>
    JSON.stringify(await transcript(t, receipt.threadId)).includes("unique final marker"),
  );

  expect(calls("Main")).toHaveLength(2);
  parentHeld.release();
  await drain(t);
  expect(calls("Main")).toHaveLength(3);
  const prompt = JSON.stringify(calls("Main")[2].args.prompt);

  expect(prompt.indexOf("first progress marker")).toBeLessThan(
    prompt.indexOf("second progress marker"),
  );

  expect(prompt.indexOf("second progress marker")).toBeLessThan(
    prompt.indexOf("unique final marker"),
  );

  const history = await transcript(t, receipt.threadId);

  expect(
    history.page.filter((entry) => entry.text?.includes("first progress marker")),
  ).toHaveLength(1);

  expect(
    history.page.filter((entry) => entry.text?.includes("second progress marker")),
  ).toHaveLength(1);
});

it("a root has no message_parent tool and its internal path returns NO_PARENT", async () => {
  const t = setup();
  const held = gate();

  v2.steps.Main = async () => {
    await held.promise;

    return text("done");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Main").length === 1);
  const root = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;

  expect(calls("Main")[0].args.tools?.map((entry) => entry.name)).not.toContain(
    "agevex_message_parent",
  );

  expect(
    await send(t, { assignmentId: root._id, turnToken: root.turnToken! }, "no parent"),
  ).toMatchObject({ status: "denied", code: "NO_PARENT" });

  held.release();
  await drain(t);
});

it.each(["approval", "deferred"] as const)(
  "progress cannot wake or bypass a parent with an unresolved %s call",
  async (boundary) => {
    const t = setup(undefined, boundary);
    const childHeld = gate();

    v2.steps.Main = (n) =>
      n === 0
        ? [delegate("Reviewer")]
        : n === 1
          ? [call("human", {}, "human-call")]
          : text("human result consumed");

    v2.steps.Reviewer = async () => {
      await childHeld.promise;

      return text("child final");
    };

    const receipt = await open(t);

    await waitFor(t, () => calls("Reviewer").length === 1);
    const actor = await sender(t, receipt.threadId);

    expect(await send(t, actor, "start parent question")).toMatchObject({ status: "accepted" });

    await waitFor(
      t,
      async () =>
        !!(await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.approvalBlocked,
    );

    await t.action(async () => {
      await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
    });

    expect(await send(t, actor, "progress behind human boundary")).toMatchObject({
      status: "accepted",
    });

    // Let the doorbell and its pending scheduled work run; the native guard must
    // retain the pause rather than accidentally making a progress turn runnable.
    for (let i = 0; i < 5; i++)
      await t.action(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

    expect(calls("Main")).toHaveLength(2);

    expect(await t.query(rawAssignment, { assignmentId: receipt.assignmentId })).toMatchObject({
      approvalBlocked: true,
    });

    if (boundary === "deferred") {
      await owner(t).mutation(api.agents.answer, {
        threadId: receipt.threadId,
        toolCallId: "human-call",
        value: "approved human answer",
      });
    } else {
      const row = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;

      const [request] = await t.query(components.agent.messages.getMessagesByIds, {
        messageIds: [row.approvals!.requests[0].messageId],
      });

      const content = request!.message!.content;

      const approval = Array.isArray(content)
        ? content.find((part) => part.type === "tool-approval-request")
        : undefined;

      if (approval?.type !== "tool-approval-request") throw new Error("APPROVAL_MISSING");

      await owner(t).mutation(api.agents.respond, {
        threadId: receipt.threadId,
        approvalId: approval.approvalId,
        decision: { kind: "approve" },
      });
    }

    // Deferred answers already commit a tool result, so that safe continuation
    // may coalesce progress; approvals require a generation to produce results first.
    const expectedTurns = boundary === "approval" ? 4 : 3;

    await waitFor(t, () => calls("Main").length >= expectedTurns);
    const safe = JSON.stringify(calls("Main")[expectedTurns - 1].args.prompt);

    expect(safe).toContain("progress behind human boundary");
    expect(safe.indexOf("approved")).toBeLessThan(safe.indexOf("progress behind human boundary"));
    childHeld.release();

    await waitFor(
      t,
      async () =>
        (await tree(t, receipt.threadId))[0].status === "completed" &&
        (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.turnStatus ===
          "idle",
    );

    await drain(t);
  },
);

it("nested progress reaches only the immediate persisted parent before the descendant final result", async () => {
  const t = setup();
  const held = gate();

  v2.steps.Main = (n) => (n === 0 ? [delegate("Builder")] : text("root done"));
  v2.steps.Builder = (n) => (n === 0 ? [delegate("Reviewer")] : text("builder read"));

  v2.steps.Reviewer = async (n) => {
    if (n === 0) return [call("agevex_message_parent", { text: "nested progress" })];

    await held.promise;

    return text("reviewer final");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Builder").length === 2 && calls("Reviewer").length === 2);
  expect(calls("Main")).toHaveLength(1);
  expect(JSON.stringify(calls("Builder")[1].args.prompt)).toContain("nested progress");
  expect(JSON.stringify(await transcript(t, receipt.threadId))).not.toContain("nested progress");
  held.release();
  await drain(t);
  expect((await tree(t, receipt.threadId)).every((run) => run.status === "completed")).toBe(true);
});

it("five reviewers with four notes five seconds apart cannot starve any final result across four child lanes", async () => {
  const t = setup();
  const children = Array.from({ length: 5 }, () => gate());
  const parentHeld = gate();
  const responses: Awaited<ReturnType<typeof send>>[] = [];

  v2.steps.Main = async (n) => {
    if (n === 0) return children.map(() => delegate("Reviewer"));

    if (n === 1) await parentHeld.promise;

    return text("read every final");
  };

  v2.steps.Reviewer = async (n) => {
    await children[n].promise;

    return text(`reviewer final ${n}`);
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 4);

  expect((await tree(t, receipt.threadId)).filter((run) => run.status === "queued")).toHaveLength(
    1,
  );

  // Send four notes from each running reviewer while the parent holds its
  // progress turn. The fifth child is queued but already owns a future result.
  for (let round = 0; round < 4; round++) {
    for (let child = 0; child < 4; child++)
      responses.push(
        await send(t, await sender(t, receipt.threadId, child), `note ${child}/${round}`),
      );

    await t.action(async () => {
      await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
    });
  }

  // The reported reproduction used an ask and answer to steal two of the
  // five owed result hops after the fourteen accepted notes.
  expect(
    await t.mutation(api.agents.coordinate, {
      op: "ask",
      ...(await sender(t, receipt.threadId)),
      question: "would steal a reserved final hop",
    }),
  ).toMatchObject({ status: "denied", code: "RUN_BUDGET" });

  const parent = (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!;

  expect(
    await t.mutation(api.agents.coordinate, {
      op: "message",
      assignmentId: parent._id,
      turnToken: parent.turnToken!,
      runId: (await tree(t, receipt.threadId))[0].runId,
      text: "would also steal a reserved final hop",
    }),
  ).toMatchObject({ status: "denied", code: "RUN_BUDGET" });

  children[0].release();
  await waitFor(t, () => calls("Reviewer").length === 5);

  for (let round = 0; round < 4; round++) {
    responses.push(await send(t, await sender(t, receipt.threadId, 4), `note 4/${round}`));

    await t.action(async () => {
      await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
    });
  }

  expect(responses.filter((result) => result?.status === "accepted")).toHaveLength(14);
  expect(responses.filter((result) => result?.status === "denied")).toHaveLength(6);

  expect(
    responses
      .filter((result) => result?.status === "denied")
      .every((result) => result.code === "RUN_BUDGET" || result.code === "QUEUE_LIMIT"),
  ).toBe(true);

  for (const child of children) child.release();

  await waitFor(
    t,
    async () =>
      (await transcript(t, receipt.threadId)).page.filter((entry) => entry.origin === "result")
        .length === 5,
  );

  expect(await hops(t, receipt.assignmentId)).toBe(HOST_LIMITS.runHops.default);

  expect(
    (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!.queuedMessages,
  ).toBeLessThanOrEqual(HOST_LIMITS.queueLength.default);

  parentHeld.release();
  await drain(t);
  const prompt = JSON.stringify(calls("Main")[calls("Main").length - 1].args.prompt);
  const history = await transcript(t, receipt.threadId);

  for (let child = 0; child < 5; child++) {
    expect(prompt).toContain(`reviewer final ${child}`);

    expect(
      history.page.filter(
        (entry) => entry.origin === "result" && entry.text?.includes(`reviewer final ${child}`),
      ),
    ).toHaveLength(1);
  }
});

it("the full 58-row delivery range reserves a settled child's final hop after activeRuns drops", async () => {
  const maxima = Object.fromEntries(
    Object.entries(HOST_LIMITS).map(([key, value]) => [key, value.max]),
  );

  const t = setup(maxima);
  const { seed } = addHeadroomFixture(t);
  const held = gate();

  v2.steps.Main = (n) => (n === 0 ? [delegate("Reviewer")] : text("read final"));

  v2.steps.Reviewer = async () => {
    await held.promise;

    return text("done");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 1);
  const actor = await sender(t, receipt.threadId);

  await t.mutation(seed, { assignmentId: receipt.assignmentId });

  expect((await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))!.activeRuns).toBe(
    1,
  );

  expect(await send(t, actor, "last optional progress hop")).toMatchObject({ status: "accepted" });

  await waitFor(t, () => calls("Main").length === 2);

  await t.action(async () => {
    await vi.advanceTimersByTimeAsync(LIMITS.parentNoteIntervalMs);
  });

  expect(await send(t, actor, "would spend the terminal child's reserved hop")).toMatchObject({
    status: "denied",
    code: "RUN_BUDGET",
  });

  expect(await hops(t, receipt.assignmentId)).toBe(HOST_LIMITS.runHops.max - 2);
  expect(JSON.stringify(await transcript(t, receipt.threadId))).not.toContain("reserved hop");
  expect(calls("Main")).toHaveLength(2);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
});

it("notes use free message slots while results from older user requests still deliver", async () => {
  const t = setup({ queueLength: 2 });
  const held = gate();

  v2.steps.Main = (n) => (n < 2 ? [delegate("Reviewer")] : text("read both requests"));

  v2.steps.Reviewer = async (n) => {
    await held.promise;

    return text(`request final ${n}`);
  };

  const receipt = await open(t);

  await waitFor(
    t,
    async () =>
      calls("Reviewer").length === 1 &&
      (await t.query(rawAssignment, { assignmentId: receipt.assignmentId }))?.turnStatus === "idle",
  );

  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "another request while the first reviewer works",
    requestKey: "second-request",
  });

  await waitFor(t, () => calls("Reviewer").length === 2);

  expect(
    await send(t, await sender(t, receipt.threadId), "progress beside old and new final results"),
  ).toMatchObject({ status: "accepted" });

  expect(await hops(t, receipt.assignmentId)).toBe(2);
  held.release();
  await drain(t);
  const history = await transcript(t, receipt.threadId);
  const prompt = JSON.stringify(calls("Main")[calls("Main").length - 1].args.prompt);

  for (let request = 0; request < 2; request++) {
    expect(
      history.page.filter(
        (entry) => entry.origin === "result" && entry.text?.includes(`request final ${request}`),
      ),
    ).toHaveLength(1);

    expect(prompt).toContain(`request final ${request}`);
  }
});

it("pending results across budgets do not reserve message queue slots under real transaction limits", async () => {
  const maxima = Object.fromEntries(
    Object.entries(HOST_LIMITS).map(([key, value]) => [key, value.max]),
  );

  const t = setup(maxima);
  const { fillQueue } = addHeadroomFixture(t);
  const held = gate();

  v2.steps.Main = () => [delegate("Reviewer")];

  v2.steps.Reviewer = async () => {
    await held.promise;

    return text("done");
  };

  const receipt = await open(t);

  await waitFor(t, () => calls("Reviewer").length === 1);
  const actor = await sender(t, receipt.threadId);

  await t.mutation(fillQueue, { assignmentId: receipt.assignmentId });

  expect(await send(t, actor, "a message uses actual queue occupancy")).toMatchObject({
    status: "accepted",
  });

  expect(await hops(t, receipt.assignmentId)).toBe(2);
  expect(JSON.stringify(await transcript(t, receipt.threadId))).toContain("actual queue occupancy");
  expect(calls("Main")).toHaveLength(1);
  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });
  held.release();
  await drain(t);
});
