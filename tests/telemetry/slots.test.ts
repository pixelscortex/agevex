// @vitest-environment edge-runtime
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import agevex from "../../src/test.js";
import schema from "../fixture/schema.js";
import { components } from "../fixture/api.js";
import { api, exports, fixture, registration, reset, text } from "../hooks.host.js";
import { requireReceipt } from "../receipt.js";
import { opaqueKey } from "../../src/client/keys.js";
import type { TurnArgs } from "../../src/client/index.js";
import type { SlotActionCtx } from "../../src/client/slots.js";
import { langfuse, telemetry, type OtlpPayload, type Span } from "../../src/telemetry/index.js";
import { facts, scripted } from "./script.js";

const modules = import.meta.glob(["../fixture/**/*.ts", "../fixture/**/*.js"]);
function setup() {
  const t = convexTest({
    schema,
    transactionLimits: true,
    modules: { ...modules, "../fixture/agents.ts": async () => exports() },
  });
  agent.register(t);
  agevex.register(t);
  return t;
}
type Test = ReturnType<typeof setup>;
const owner = (t: Test) => t.withIdentity({ subject: "alice" });
const open = (t: Test, requestKey = "first") =>
  owner(t)
    .mutation(api.agents.open, { agent: "Main", prompt: requestKey, requestKey })
    .then(requireReceipt);
const drain = (t: Test) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(100), 3000);
const spansIn = (body: OtlpPayload) =>
  body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
const attributesOf = (span: Span) =>
  Object.fromEntries(span.attributes.map(({ key, value }) => [key, Object.values(value)[0]]));
const status = (t: Test, threadId: string) => owner(t).query(api.agents.activity, { threadId });
function capture() {
  const bodies: OtlpPayload[] = [];
  const slot = telemetry.slot({
    exporters: [{ export: (body) => void bodies.push(body) }],
  });
  fixture.slots.telemetry = slot;
  return { bodies, slot };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("a managed fake-model turn exports all six slot facts on every span", async () => {
  const { bodies } = capture();
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect(bodies).toHaveLength(1);
  const execution = (await t.query(components.agevex.queue.execution, {
    assignmentId: receipt.assignmentId,
  }))!;
  const turnKey = await opaqueKey("turn", execution.lastSlice);
  const spans = spansIn(bodies[0]);
  expect(spans.map((span) => span.name.split(" ")[0])).toEqual(["invoke_agent", "step", "chat"]);
  for (const span of spans) {
    expect(attributesOf(span)).toMatchObject({
      "langfuse.user.id": "alice",
      "langfuse.session.id": receipt.threadId,
      "langfuse.trace.metadata.thread_id": receipt.threadId,
      "langfuse.trace.metadata.run_id": execution.runId,
      "langfuse.trace.metadata.agent": "Main",
      "langfuse.trace.metadata.turn_key": turnKey,
    });
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.spanId).toMatch(/^[a-f0-9]{16}$/);
  }
  expect((await status(t, receipt.threadId)).errorCode).toBeNull();
});

it("managed flush posts OTLP JSON to the configured endpoint exactly once per turn", async () => {
  const bodies: OtlpPayload[] = [];
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(input).toBe("https://langfuse.example/api/public/otel/v1/traces");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-langfuse-ingestion-version": "4",
    });
    bodies.push(JSON.parse(init!.body as string) as OtlpPayload);
    return new Response(null, { status: 200 });
  });
  fixture.slots.telemetry = telemetry.slot({
    exporters: [
      langfuse({ baseUrl: "https://langfuse.example", publicKey: "pk", secretKey: "sk" }),
    ],
  });
  const t = setup();
  const receipt = await open(t);
  await drain(t);
  expect(request).toHaveBeenCalledTimes(1);
  await owner(t).mutation(api.agents.send, {
    threadId: receipt.threadId,
    text: "another turn",
    requestKey: "second",
  });
  await drain(t);
  expect(request).toHaveBeenCalledTimes(2);
  const roots = bodies.map((body) => spansIn(body)[0]);
  expect(new Set(roots.map((span) => span.traceId)).size).toBe(2);
  for (const body of bodies) {
    const spans = spansIn(body);
    expect(spans).toHaveLength(3);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(spans[1].parentSpanId).toBe(spans[0].spanId);
    expect(spans[2].parentSpanId).toBe(spans[1].spanId);
  }
});

it("two concurrent managed turns in one action flush only their own buffers", async () => {
  const { bodies } = capture();
  const gates = [gate(), gate()];
  fixture.steps.Main = async (n) => {
    await gates[n].promise;
    return text(`answer ${n}`);
  };
  const t = setup();
  const receipts = [await open(t), await open(t, "second")];
  const executions = await Promise.all(
    receipts.map((receipt) =>
      t.query(components.agevex.queue.execution, { assignmentId: receipt.assignmentId }),
    ),
  );
  // Convex strips @internal _handler from its shipped declarations, though the
  // registered value exposes it (convex/src/server/registration.ts:592). Calling
  // it here keeps both real turn handlers in the same action rather than testing
  // isolation only across separate action invocations.
  const runTurn = registration().internalFunctions().runTurn as unknown as {
    _handler(ctx: SlotActionCtx, args: TurnArgs): Promise<null>;
  };
  // Invoke the real registered handlers with one action context and one shared
  // slot. Gates keep both model calls live, then flush the first while the other
  // is still unfinished: a shared buffer would export its sibling's open spans.
  const running = t.action(async (ctx) =>
    Promise.all(
      receipts.map((receipt, n) =>
        runTurn._handler(ctx, {
          assignmentId: receipt.assignmentId,
          turnToken: executions[n]!.turnToken!,
        }),
      ),
    ),
  );
  await expect
    .poll(async () => {
      await vi.advanceTimersByTimeAsync(10);
      return fixture.calls.length;
    })
    .toBe(2);
  gates[0].release();
  await expect
    .poll(async () => {
      await vi.advanceTimersByTimeAsync(10);
      return bodies.length;
    })
    .toBe(1);
  expect(spansIn(bodies[0])).toHaveLength(3);
  const firstThread = attributesOf(spansIn(bodies[0])[0])["langfuse.trace.metadata.thread_id"];
  gates[1].release();
  await expect
    .poll(async () => {
      await vi.advanceTimersByTimeAsync(10);
      return bodies.length;
    })
    .toBe(2);
  await running;
  await drain(t);
  expect(bodies).toHaveLength(2);
  expect(new Set(bodies.map((body) => spansIn(body)[0].traceId)).size).toBe(2);
  expect(
    new Set(
      bodies.map((body) => attributesOf(spansIn(body)[0])["langfuse.trace.metadata.thread_id"]),
    ),
  ).toEqual(new Set(receipts.map((receipt) => receipt.threadId)));
  expect(attributesOf(spansIn(bodies[1])[0])["langfuse.trace.metadata.thread_id"]).not.toBe(
    firstThread,
  );
  for (const body of bodies) {
    const spans = spansIn(body);
    expect(spans).toHaveLength(3);
    expect(
      new Set(spans.map((span) => attributesOf(span)["langfuse.trace.metadata.thread_id"])).size,
    ).toBe(1);
    expect(
      new Set(spans.map((span) => attributesOf(span)["langfuse.trace.metadata.turn_key"])).size,
    ).toBe(1);
    expect(spans.every((span) => span.status.code === 1)).toBe(true);
  }
});

it.each(["throws", "hangs"])(
  "an exporter that %s cannot fail a managed turn or leak into the next",
  async (failure) => {
    const attempts: OtlpPayload[] = [];
    let receivedSignal: AbortSignal | undefined;
    fixture.slots.telemetry = telemetry.slot({
      exporters: [
        {
          export(body, signal) {
            attempts.push(body);
            receivedSignal = signal;
            if (attempts.length > 1) return;
            if (failure === "throws") throw new Error("export unavailable");
            return new Promise<void>(() => {});
          },
        },
      ],
    });
    const t = setup();
    const receipt = await open(t);
    await drain(t);
    expect(attempts).toHaveLength(1);
    expect(receivedSignal?.aborted).toBe(true);
    expect((await status(t, receipt.threadId)).errorCode).toBeNull();
    await owner(t).mutation(api.agents.send, {
      threadId: receipt.threadId,
      text: "next turn",
      requestKey: "next",
    });
    await drain(t);
    expect((await status(t, receipt.threadId)).errorCode).toBeNull();
    expect(attempts).toHaveLength(2);
    expect(attempts.map((body) => spansIn(body).length)).toEqual([3, 3]);
    expect(spansIn(attempts[1])[0].traceId).not.toBe(spansIn(attempts[0])[0].traceId);
  },
);

it.each(["before", "during"])(
  "slot cancellation %s export discards only that buffer and permits stable-id retries",
  async (when) => {
    const bodies: OtlpPayload[] = [];
    const controller = new AbortController();
    let started!: () => void;
    const exporting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slot = telemetry.slot({
      exporters: [
        {
          export(body) {
            bodies.push(body);
            started();
            return bodies.length === 1 && when === "during"
              ? new Promise<void>(() => {})
              : undefined;
          },
        },
      ],
    });
    await scripted(slot.integration(facts));
    const sibling = { ...facts, threadId: "sibling", turnKey: "sibling-turn" };
    await scripted(slot.integration(sibling));
    if (when === "before") controller.abort();
    const flushing = slot.flush(facts, controller.signal);
    if (when === "during") {
      await exporting;
      controller.abort();
    }
    await expect(flushing).resolves.toBeUndefined();
    await slot.flush(facts);
    expect(bodies).toHaveLength(when === "before" ? 0 : 1);
    await slot.flush(sibling);
    const siblingSpans = spansIn(bodies[bodies.length - 1]);
    expect(siblingSpans).toHaveLength(6);
    expect(
      siblingSpans.every(
        (span) => attributesOf(span)["langfuse.trace.metadata.turn_key"] === sibling.turnKey,
      ),
    ).toBe(true);
    await scripted(slot.integration(facts));
    await slot.flush(facts);
    expect(bodies).toHaveLength(when === "before" ? 2 : 3);
    if (when === "during")
      expect(spansIn(bodies[2]).map(({ traceId, spanId }) => [traceId, spanId])).toEqual(
        spansIn(bodies[0]).map(({ traceId, spanId }) => [traceId, spanId]),
      );
  },
);
