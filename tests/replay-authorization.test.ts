// @vitest-environment edge-runtime
// Fresh-work admission preserves host identity mapping and subject-private retries.
// Host patches/scheduler writes share the real component acceptance transaction.
import { listMessages } from "@convex-dev/agent";
import { componentsGeneric, makeFunctionReference, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setup, api, components, state } from "./setup.js";
import { requireReceipt } from "./receipt.js";
import admissionSchema from "./fixture/admission.schema.js";

type Test = ReturnType<typeof setup>;
const TEST_LIMITS = { queueLength: 1, inspectRows: 20, scheduledDelayMs: 60_000 } as const;

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Exercise both public endpoints against real components and the fake model. */
async function acceptedRequest(operation: "open" | "send", subjectPrefix = "") {
  const t = setup(undefined, { queueLength: TEST_LIMITS.queueLength }, true, admissionSchema);

  state.subjectPrefix = subjectPrefix;
  const owner = t.withIdentity({ subject: "alice" });
  const input = { agent: "Main", prompt: "paid work", requestKey: "paid" };
  const root = await owner.mutation(api.agents.open, input).then(requireReceipt);
  const send = { threadId: root.threadId, text: "next paid work", requestKey: "next" };
  const requestKey = operation === "open" ? input.requestKey : send.requestKey;

  const request = (change: { requestKey?: string; text?: string } = {}) =>
    operation === "open"
      ? owner.mutation(api.agents.open, {
          ...input,
          requestKey: change.requestKey ?? requestKey,
          prompt: change.text ?? input.prompt,
        })
      : owner.mutation(api.agents.send, { ...send, ...change });

  const accepted = operation === "open" ? root : await request().then(requireReceipt);

  return { t, owner, input, send, requestKey, request, accepted };
}

/** Inspect this tiny fixture only; production code never scans transcripts. */
async function requestWrites(t: Test, subject = "alice") {
  const threads = await t.query(components.agent.threads.listThreadsByUserId, {
    userId: subject,
    paginationOpts: { cursor: null, numItems: TEST_LIMITS.inspectRows },
  });

  const messages = await Promise.all(
    threads.page.map(({ _id: threadId }) =>
      t.run((ctx) =>
        listMessages(ctx, components.agent, {
          threadId,
          paginationOpts: { cursor: null, numItems: TEST_LIMITS.inspectRows },
        }),
      ),
    ),
  );

  const bridge = componentsGeneric().agevex.agevexTest;

  return {
    threads: threads.page,
    messages: messages.map(({ page }) => page),
    work: await t.query(bridge.queuedWork as unknown as FunctionReference<"query">, {}),
    receipts: await t.query(bridge.receiptCount as unknown as FunctionReference<"query">, {}),
  };
}

/** A real host patch and scheduled function, performed before any injected refusal. */
async function hostWrites(t: Test) {
  const id = await t.run((ctx) => ctx.db.insert("admissionProbes", { accepted: 0 }));

  state.admit = async (ctx) => {
    const row = await ctx.db.get(id);

    if (typeof row?.accepted !== "number") throw new Error("MISSING_HOST_PROBE");

    await ctx.db.patch(id, { accepted: row.accepted + 1 });

    await ctx.scheduler.runAfter(
      TEST_LIMITS.scheduledDelayMs,
      makeFunctionReference<"mutation">("admission:scheduled"),
      {},
    );
  };

  return () =>
    t.run(async (ctx) => ({
      accepted: (await ctx.db.get(id))!.accepted,
      scheduled: (await ctx.db.system.query("_scheduled_functions").take(TEST_LIMITS.inspectRows))
        .filter(({ name }) => name === "admission:scheduled")
        .map(({ _id }) => _id),
    }));
}

it.each(["open", "send"] as const)(
  "%s replays the stored receipt without admit after the host refuses fresh work",
  async (operation) => {
    const { t, request, accepted, requestKey } = await acceptedRequest(operation);
    const before = await requestWrites(t);
    const admissions = state.admissions.length;
    const authorizations = state.requestScopes.length;

    expect(state.admissions[state.admissions.length - 1]).toEqual({
      subject: "alice",
      operation,
      agent: "Main",
      requestKey,
      ...(operation === "send" ? { threadId: accepted.threadId } : {}),
    });

    state.denyFreshRequests = true;
    expect(await request()).toEqual({ ...accepted, status: "duplicate" });
    expect(state.admissions).toHaveLength(admissions);
    expect(state.requestScopes).toHaveLength(authorizations + 1);

    expect(state.requestScopes[state.requestScopes.length - 1]).toEqual({
      operation,
      agent: "Main",
      requestKey,
      ...(operation === "send" ? { threadId: accepted.threadId } : {}),
    });

    expect(await requestWrites(t)).toEqual(before);
  },
);

it.each(["open", "send"] as const)(
  "%s calls admit for a fresh key and rolls back host, scheduler, native, inbox and receipt writes on refusal",
  async (operation) => {
    const { t, owner, request, accepted } = await acceptedRequest(operation);

    // Free the one-row queue so the send reaches host admission.
    if (operation === "send") {
      await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100));
      expect(state.calls.length).toBeGreaterThan(0);
    }

    const inspectHost = await hostWrites(t);
    const hostBefore = await inspectHost();
    const before = await requestWrites(t);
    const admissions = state.admissions.length;

    state.denyFreshRequests = true;
    await expect(request({ requestKey: "fresh" })).rejects.toThrow("OUT_OF_BALANCE");
    expect(state.admissions).toHaveLength(admissions + 1);

    expect(state.admissions[state.admissions.length - 1]).toMatchObject({
      operation,
      requestKey: "fresh",
    });

    expect(await inspectHost()).toEqual(hostBefore);
    expect(await requestWrites(t)).toEqual(before);

    // The refused key was not reserved; it can be accepted on the next attempt.
    state.denyFreshRequests = false;
    const fresh = await request({ requestKey: "fresh" }).then(requireReceipt);

    expect(fresh.status).toBe("accepted");
    expect(await inspectHost()).toMatchObject({ accepted: 1, scheduled: [expect.any(String)] });

    const page = await owner.query(api.agents.messages, {
      threadId: fresh.threadId,
      paginationOpts: { cursor: null, numItems: TEST_LIMITS.inspectRows },
    });

    expect(
      page.page.some(({ text }) =>
        text.includes(operation === "open" ? "paid work" : "next paid work"),
      ),
    ).toBe(true);

    expect(fresh.receiptId).not.toBe(accepted.receiptId);
  },
);

it.each(["open", "send"] as const)(
  "%s returns KEY_CONFLICT for changed input without calling admit",
  async (operation) => {
    const { t, request } = await acceptedRequest(operation);
    const before = await requestWrites(t);
    const admissions = state.admissions.length;

    state.denyFreshRequests = true;

    expect(await request({ text: "different paid work" })).toEqual({
      status: "rejected",
      code: "KEY_CONFLICT",
    });

    expect(state.admissions).toHaveLength(admissions);
    expect(await requestWrites(t)).toEqual(before);
  },
);

it.each(["open", "send"] as const)(
  "%s keeps receipts isolated by the host-mapped subject",
  async (operation) => {
    const { t, input, send, accepted, request } = await acceptedRequest(operation, "host:");
    const bob = t.withIdentity({ subject: "bob" });
    let other;

    if (operation === "open") {
      other = await bob.mutation(api.agents.open, input).then(requireReceipt);
      expect(other.threadId).not.toBe(accepted.threadId);
      expect(await bob.mutation(api.agents.open, input)).toEqual({ ...other, status: "duplicate" });
    } else {
      const admissions = state.admissions.length;

      await expect(bob.mutation(api.agents.send, send)).rejects.toThrow("FORBIDDEN");
      expect(state.admissions).toHaveLength(admissions);

      const otherRoot = await bob
        .mutation(api.agents.open, { ...input, requestKey: "bob-root" })
        .then(requireReceipt);

      const otherSend = { ...send, threadId: otherRoot.threadId };

      other = await bob.mutation(api.agents.send, otherSend).then(requireReceipt);

      expect(await bob.mutation(api.agents.send, otherSend)).toEqual({
        ...other,
        status: "duplicate",
      });
    }

    expect(other.status).toBe("accepted");
    expect(other.receiptId).not.toBe(accepted.receiptId);
    expect(state.admissions[state.admissions.length - 1]?.subject).toBe("host:bob");
    expect(await request()).toEqual({ ...accepted, status: "duplicate" });
  },
);

it.each(["open", "send"] as const)(
  "%s accepts and replays with a custom subject different from the auth identity",
  async (operation) => {
    const { t, request, accepted } = await acceptedRequest(operation, "host:");
    const admissions = state.admissions.length;
    const stored = await requestWrites(t, "host:alice");

    expect(stored.threads).toHaveLength(1);
    expect(stored.threads[0].userId).toBe("host:alice");
    expect((await requestWrites(t, "alice")).threads).toEqual([]);
    expect(state.admissions[state.admissions.length - 1]?.subject).toBe("host:alice");
    state.denyFreshRequests = true;
    expect(await request()).toEqual({ ...accepted, status: "duplicate" });
    expect(state.admissions).toHaveLength(admissions);
  },
);

it.each(["open", "send"] as const)(
  "%s still authorizes replays and honors revoked access before admit",
  async (operation) => {
    const { t, request } = await acceptedRequest(operation);
    const admissions = state.admissions.length;
    const authorizations = state.requestScopes.length;
    const before = await requestWrites(t);

    state.denyAllRequests = true;
    await expect(request()).rejects.toThrow("FORBIDDEN");
    expect(state.requestScopes).toHaveLength(authorizations + 1);
    expect(state.admissions).toHaveLength(admissions);
    expect(await requestWrites(t)).toEqual(before);
  },
);

it("a full queue returns QUEUE_FULL before admit and leaves host patches and scheduled work untouched", async () => {
  const { t, request } = await acceptedRequest("send");
  const inspectHost = await hostWrites(t);
  const before = await requestWrites(t);
  const admissions = state.admissions.length;

  expect(await request({ requestKey: "queue-full" })).toEqual({
    status: "rejected",
    code: "QUEUE_FULL",
  });

  expect(state.admissions).toHaveLength(admissions);
  expect(await inspectHost()).toEqual({ accepted: 0, scheduled: [] });
  expect(await requestWrites(t)).toEqual(before);
});

it.each(["open", "send"] as const)(
  "%s validates invalid input after authorization and before admit or host writes",
  async (operation) => {
    const { t, request } = await acceptedRequest(operation);
    const inspectHost = await hostWrites(t);
    const before = await requestWrites(t);
    const admissions = state.admissions.length;
    const authorizations = state.requestScopes.length;

    expect(await request({ requestKey: "invalid", text: "" })).toEqual({
      status: "rejected",
      code: "INVALID_MESSAGE",
    });

    expect(state.requestScopes).toHaveLength(authorizations + 1);
    expect(state.admissions).toHaveLength(admissions);
    expect(await inspectHost()).toEqual({ accepted: 0, scheduled: [] });
    expect(await requestWrites(t)).toEqual(before);
  },
);

it.each(["save", "accept"] as const)(
  "a later %s failure rolls back admit's host patch and scheduled work with native and coordination writes",
  async (fault) => {
    const t = setup(fault, undefined, true, admissionSchema);
    const inspectHost = await hostWrites(t);
    const before = await requestWrites(t);

    await expect(
      t.withIdentity({ subject: "alice" }).mutation(api.agents.open, {
        agent: "Main",
        prompt: "fails after admit",
        requestKey: "late-failure",
      }),
    ).rejects.toThrow("injected failure");

    expect(state.admissions).toHaveLength(1);
    expect(await inspectHost()).toEqual({ accepted: 0, scheduled: [] });
    expect(await requestWrites(t)).toEqual(before);
  },
);
