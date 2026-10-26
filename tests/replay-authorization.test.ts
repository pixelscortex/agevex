// @vitest-environment edge-runtime
// Public request authorization distinguishes retained receipt replays from new
// paid work without bypassing host policy or exposing another subject's ledger.
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setup, api, state } from "./setup.js";
import { requireReceipt } from "./receipt.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Exercise both public endpoints against real components and the fake model. */
async function acceptedRequest(operation: "open" | "send") {
  const t = setup(undefined, undefined, true);
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

it.each(["open", "send"] as const)(
  "%s replays the stored receipt after the host refuses fresh paid work",
  async (operation) => {
    const { request, accepted, requestKey } = await acceptedRequest(operation);

    expect(state.requestScopes[state.requestScopes.length - 1]).toMatchObject({
      operation,
      requestKey,
      replay: false,
    });

    state.denyFreshRequests = true;
    expect(await request()).toEqual({ ...accepted, status: "duplicate" });

    expect(state.requestScopes[state.requestScopes.length - 1]).toMatchObject({
      operation,
      requestKey,
      replay: true,
    });
  },
);

it.each(["open", "send"] as const)(
  "%s identifies a fresh key as replay false so the host can refuse new work",
  async (operation) => {
    const { request } = await acceptedRequest(operation);

    state.denyFreshRequests = true;
    await expect(request({ requestKey: "fresh" })).rejects.toThrow("OUT_OF_BALANCE");

    expect(state.requestScopes[state.requestScopes.length - 1]).toMatchObject({
      operation,
      requestKey: "fresh",
      replay: false,
    });
  },
);

it.each(["open", "send"] as const)(
  "%s keeps changed payloads under the same key as KEY_CONFLICT with replay false",
  async (operation) => {
    const { request, requestKey } = await acceptedRequest(operation);

    expect(await request({ text: "different paid work" })).toEqual({
      status: "rejected",
      code: "KEY_CONFLICT",
    });

    expect(state.requestScopes[state.requestScopes.length - 1]).toMatchObject({
      operation,
      requestKey,
      replay: false,
    });
  },
);

it.each(["open", "send"] as const)(
  "%s keeps receipt lookup private when another subject reuses the key",
  async (operation) => {
    const { t, input, send, accepted, requestKey } = await acceptedRequest(operation);
    const bob = t.withIdentity({ subject: "bob" });

    if (operation === "open") {
      const other = await bob.mutation(api.agents.open, input).then(requireReceipt);

      expect(other.status).toBe("accepted");
      expect(other.receiptId).not.toBe(accepted.receiptId);
      expect(other.threadId).not.toBe(accepted.threadId);
    } else {
      await expect(bob.mutation(api.agents.send, send)).rejects.toThrow("FORBIDDEN");

      expect(state.requestScopes[state.requestScopes.length - 1]).toMatchObject({
        operation,
        requestKey,
        replay: false,
      });

      const otherRoot = await bob
        .mutation(api.agents.open, { ...input, requestKey: "bob-root" })
        .then(requireReceipt);

      const other = await bob
        .mutation(api.agents.send, { ...send, threadId: otherRoot.threadId })
        .then(requireReceipt);

      expect(other.status).toBe("accepted");
      expect(other.receiptId).not.toBe(accepted.receiptId);
    }

    expect(state.requestScopes[state.requestScopes.length - 1]).toMatchObject({
      operation,
      requestKey,
      replay: false,
    });
  },
);

it.each(["open", "send"] as const)(
  "%s still calls authorize on a replay and honors a host that refuses everything",
  async (operation) => {
    const { request, requestKey } = await acceptedRequest(operation);

    state.denyAllRequests = true;
    await expect(request()).rejects.toThrow("OUT_OF_BALANCE");

    expect(state.requestScopes[state.requestScopes.length - 1]).toMatchObject({
      operation,
      requestKey,
      replay: true,
    });
  },
);
