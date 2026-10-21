// @vitest-environment edge-runtime
import { expect, it } from "vite-plus/test";
import { api, setup } from "./setup.js";
import { state } from "./host.js";

const drain = (t: ReturnType<typeof setup>) => t.finishAllScheduledFunctions(() => {});

it("emits metadata-only lifecycle events without changing execution", async () => {
  const t = setup();
  const alice = t.withIdentity({ subject: "alice" });
  const receipt = await alice.mutation(api.agents.open, {
    agent: "Main",
    prompt: "observe this request",
    requestKey: "observe-1",
  });
  expect(
    await alice.mutation(api.agents.open, {
      agent: "Main",
      prompt: "observe this request",
      requestKey: "observe-1",
    }),
  ).toEqual(receipt);

  await drain(t);
  expect(state.events.map((event) => event.type)).toEqual([
    "request.accepted",
    "request.replayed",
    "turn.claimed",
    "turn.finished",
  ]);
  expect(state.events[0]).toMatchObject({
    type: "request.accepted",
    operation: "open",
    threadId: receipt.threadId,
    agent: "Main",
    subject: "alice",
  });

  state.observerFails = true;
  const second = await alice.mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "observer failures are isolated",
    requestKey: "observe-2",
  });
  expect(second.status).toBe("accepted");
});
