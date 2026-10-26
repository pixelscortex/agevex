// @vitest-environment edge-runtime
/** A delivery whose attempt and failure record both throw must not hold a result slot forever. */
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { v2, delegate, text } from "./delegation-v2.host.js";
import { setup, open, owner, waitFor, api, calls } from "./message-parent.fixture.js";
import { breakDelivery, claimNextRequest } from "./delivery-unknown.fixture.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Harness = ReturnType<typeof setup>;
type Actor = Awaited<ReturnType<typeof claimNextRequest>>;

const deliveries = async (t: Harness, threadId: string) =>
  (
    await owner(t).query(api.agents.delegations, {
      threadId,
      paginationOpts: { cursor: null, numItems: 50 },
    })
  ).page;

const launch = (t: Harness, actor: Actor, toolCallId: string) =>
  t.mutation(api.agents.coordinate, {
    op: "launch",
    ...actor,
    toolCallId,
    agent: "Reviewer",
    task: "next task",
  });

it("a delivery whose failure record also throws ends failed as DELIVERY_UNKNOWN and frees its launch slot", async () => {
  // One cross-request result slot: while the first Reviewer's delivery is
  // pending, no later request may launch another child.
  const t = setup({ runLaunches: 1 });
  const fault = breakDelivery(t);

  fault.allowed.add("unknown");
  v2.steps.Main = (n) => (!n ? [delegate("Reviewer")] : text("done"));
  const receipt = await open(t);

  await waitFor(t, () => fault.writes.unknown === 1);

  const [run] = await deliveries(t, receipt.threadId);

  expect(run).toMatchObject({
    status: "completed",
    deliveryStatus: "failed",
    errorCode: "DELIVERY_UNKNOWN",
    resultMessageId: null,
  });

  // One attempt, one failure record, one unknown record; nothing was replayed.
  expect(fault.writes).toEqual({ accepted: 1, failed: 1, failDelivery: 0, unknown: 1 });
  expect(calls("Reviewer")).toHaveLength(1);

  const next = await claimNextRequest(t, receipt, "after-unknown");

  expect(await launch(t, next, "after-unknown")).toMatchObject({ status: "queued" });
}, 30_000);

it("a delivery whose three writes all throw stays pending until a cancel frees its launch slot", async () => {
  const t = setup({ runLaunches: 1 });
  const fault = breakDelivery(t);

  v2.steps.Main = (n) => (!n ? [delegate("Reviewer")] : text("done"));
  const receipt = await open(t);

  await waitFor(t, () => fault.writes.unknown === 1);

  expect(fault.writes).toEqual({ accepted: 1, failed: 1, failDelivery: 0, unknown: 1 });

  const [run] = await deliveries(t, receipt.threadId);

  expect(run).toMatchObject({ status: "completed", deliveryStatus: "pending" });

  // The pending result still holds the only slot, so a fresh request is denied.
  const blocked = await claimNextRequest(t, receipt, "blocked");

  expect(await launch(t, blocked, "blocked")).toMatchObject({ status: "denied" });

  await owner(t).mutation(api.agents.cancel, { threadId: receipt.threadId });

  const after = await claimNextRequest(t, receipt, "after-cancel");

  expect(await launch(t, after, "after-cancel")).toMatchObject({ status: "queued" });
  expect(calls("Reviewer")).toHaveLength(1);
}, 30_000);

it("a scheduled notify whose failure record also throws records DELIVERY_UNKNOWN", async () => {
  // Main launches a Builder, which launches a Reviewer. The Reviewer's direct
  // delivery fails and records `DELIVERY_FAILED`; the Builder then settles
  // failed and is delivered by the scheduled notify action, whose coordinator
  // call and failure record are both refused.
  const t = setup();
  const fault = breakDelivery(t);

  fault.allowed.add("failed");
  fault.allowed.add("unknown");
  v2.steps.Main = (n) => (!n ? [delegate("Builder")] : text("root done"));
  v2.steps.Builder = (n) => (!n ? [delegate("Reviewer")] : text("builder done"));
  const receipt = await open(t);

  await waitFor(t, async () =>
    (await deliveries(t, receipt.threadId)).some(
      (run) => run.agent === "Builder" && run.deliveryStatus !== "pending",
    ),
  );

  const builder = (await deliveries(t, receipt.threadId)).find((run) => run.agent === "Builder")!;

  expect(builder).toMatchObject({ deliveryStatus: "failed", errorCode: "DELIVERY_UNKNOWN" });
  expect(calls("Builder")).toHaveLength(1);
}, 30_000);
