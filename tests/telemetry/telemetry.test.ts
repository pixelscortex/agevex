import { afterEach, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import {
  LIMITS,
  braintrust,
  langfuse,
  telemetry,
  type OtlpPayload,
  type Span,
  type TelemetryOptions,
} from "../../src/telemetry/index.js";
import { facts, scripted } from "./script.js";

const spansIn = (body: OtlpPayload) =>
  body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
const attributesOf = (span: Span) =>
  Object.fromEntries(span.attributes.map(({ key, value }) => [key, Object.values(value)[0]]));
const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function capture(options: Partial<TelemetryOptions> = {}) {
  const bodies: OtlpPayload[] = [];
  const observer = telemetry({
    exporters: [
      {
        export: (body) => {
          bodies.push(body);
        },
      },
    ],
    ...options,
  });
  return { observer, bodies, integration: observer.integration(facts) };
}

/** Independent OTLP wire validator: B5/B6 reject invalid ids/lists/casing together. */
function validateOtlp(body: unknown) {
  const attribute = { key: expect.any(String), value: expect.any(Object) };
  expect(body).toEqual({ resourceSpans: expect.any(Array) });
  for (const resource of (body as OtlpPayload).resourceSpans) {
    expect(resource.resource.attributes).toEqual(expect.arrayContaining([attribute]));
    expect(Array.isArray(resource.scopeSpans)).toBe(true);
    for (const scope of resource.scopeSpans) {
      expect(Array.isArray(scope.spans)).toBe(true);
      for (const span of scope.spans) {
        expect(span.traceId).toMatch(/^[a-f\d]{32}$/);
        expect(span.traceId).not.toBe("0".repeat(32));
        expect(span.spanId).toMatch(/^[a-f\d]{16}$/);
        if (span.parentSpanId) expect(span.parentSpanId).toMatch(/^[a-f\d]{16}$/);
        expect([1, 3]).toContain(span.kind);
        expect([1, 2]).toContain(span.status.code);
        expect(span.startTimeUnixNano).toMatch(/^\d+$/);
        expect(span.endTimeUnixNano).toMatch(/^\d+$/);
        expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
        expect(Array.isArray(span.attributes)).toBe(true);
        for (const entry of span.attributes) {
          expect(entry).toEqual(attribute);
          const values = Object.entries(entry.value);
          expect(values).toHaveLength(1);
          const [kind, value] = values[0];
          if (kind === "intValue") expect(value).toMatch(/^-?\d+$/);
          else if (kind === "stringValue") expect(typeof value).toBe("string");
          else if (kind === "boolValue") expect(typeof value).toBe("boolean");
          else {
            expect(kind).toBe("doubleValue");
            expect(Number.isFinite(value)).toBe(true);
          }
        }
      }
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("streamText exports agent → step → chat → tool ancestry and facts on every span", async () => {
  const { observer, bodies, integration } = capture();
  expect(await scripted(integration)).toBe("private model output");
  await observer.flush();
  validateOtlp(bodies[0]);
  const spans = spansIn(bodies[0]);
  expect(spans.map((span) => span.name)).toEqual([
    "invoke_agent Researcher",
    "step 0",
    "chat scripted-model",
    "execute_tool lookup",
    "step 1",
    "chat scripted-model",
  ]);
  const [root, step, chat, tool, secondStep, secondChat] = spans;
  expect(root.parentSpanId).toBeUndefined();
  expect(step.parentSpanId).toBe(root.spanId);
  expect(chat.parentSpanId).toBe(step.spanId);
  expect(tool.parentSpanId).toBe(chat.spanId);
  expect(secondStep.parentSpanId).toBe(root.spanId);
  expect(secondChat.parentSpanId).toBe(secondStep.spanId);
  for (const span of spans) {
    expect(span.traceId).toBe(root.traceId);
    expect(span.status.code).toBe(1);
    expect(attributesOf(span)).toMatchObject({
      "langfuse.session.id": "root",
      "langfuse.user.id": "owner",
      "langfuse.trace.name": "Researcher",
      "langfuse.trace.metadata.thread_id": "child",
      "langfuse.trace.metadata.run_id": "run",
      "langfuse.trace.metadata.agent": "Researcher",
      "langfuse.trace.metadata.turn_key": "turn",
    });
  }
  expect(attributesOf(chat)).toMatchObject({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "scripted",
    "gen_ai.request.model": "scripted-model",
    "gen_ai.response.model": "scripted-model",
    "gen_ai.usage.input_tokens": "7",
    "gen_ai.usage.output_tokens": "3",
    "langfuse.observation.type": "generation",
    "gen_ai.response.finish_reasons": '["tool-calls"]',
  });
  expect(attributesOf(root)).toMatchObject({
    "gen_ai.usage.input_tokens": "14",
    "gen_ai.usage.output_tokens": "6",
  });
  expect(attributesOf(tool)).toMatchObject({
    "langfuse.observation.type": "tool",
    "gen_ai.tool.name": "lookup",
    "gen_ai.tool.call.id": "random-tool-id",
  });
});

it("omits prompt, system, completion, tool arguments, results and errors by default", async () => {
  const { observer, integration, bodies } = capture();
  await scripted(integration, { toolFails: true });
  await observer.flush();
  expect(JSON.stringify(bodies)).not.toContain("private");
  expect(spansIn(bodies[0]).find((span) => span.name === "execute_tool lookup")?.status.code).toBe(
    2,
  );
});

it("records explicitly enabled content only after sanitization and honors SDK recording opt-outs", async () => {
  const sanitize = (value: unknown) =>
    JSON.parse(JSON.stringify(value).replaceAll("private", "redacted")) as unknown;
  const { observer, integration, bodies } = capture({
    recordInputs: true,
    recordOutputs: true,
    sanitize,
  });
  await scripted(integration);
  await observer.flush();
  const encoded = JSON.stringify(bodies);
  expect(encoded).not.toContain("private");
  expect(encoded).toContain("redacted prompt");
  expect(encoded).toContain("redacted system");
  expect(encoded).toContain("redacted model output");
  expect(encoded).toContain("redacted tool output");
  const optedOut = capture({ recordInputs: true, recordOutputs: true });
  await scripted(optedOut.integration, { recordInputs: false, recordOutputs: false });
  await optedOut.observer.flush();
  expect(JSON.stringify(optedOut.bodies)).not.toContain("private");
});

it("sanitizers redact agent, model and tool span name components before export", async () => {
  const { observer, bodies } = capture({
    sanitize: (value) =>
      typeof value === "string" ? value.replaceAll("private", "redacted") : value,
  });
  await scripted(observer.integration({ ...facts, agent: "private-agent" }), {
    modelId: "private-model",
    toolName: "private-tool",
  });
  await observer.flush();
  expect(spansIn(bodies[0]).map((span) => span.name)).toEqual([
    "invoke_agent redacted-agent",
    "step 0",
    "chat redacted-model",
    "execute_tool redacted-tool",
    "step 1",
    "chat redacted-model",
  ]);
  expect(JSON.stringify(bodies)).not.toContain("private");
});

it("throwing sanitizers replace dynamic span names without interrupting streamText", async () => {
  const { observer, integration, bodies } = capture({
    recordInputs: true,
    recordOutputs: true,
    sanitize: () => {
      throw new Error("sanitizer failed");
    },
  });
  expect(await scripted(integration)).toBe("private model output");
  await expect(observer.flush()).resolves.toBeUndefined();
  expect(JSON.stringify(bodies)).not.toContain("private");
  expect(spansIn(bodies[0]).map((span) => span.name)).toEqual([
    "invoke_agent redacted",
    "step redacted",
    "chat redacted",
    "execute_tool redacted",
    "step redacted",
    "chat redacted",
  ]);
});

it.each([undefined, null, ""])(
  "sanitizers returning %s use safe span name placeholders",
  async (value) => {
    const { observer, integration, bodies } = capture({ sanitize: () => value });
    await scripted(integration);
    await observer.flush();
    expect(spansIn(bodies[0]).every((span) => span.name.endsWith(" redacted"))).toBe(true);
  },
);

it("stable run, turn and call order derive deterministic ids despite random SDK call ids", async () => {
  const first = capture();
  const second = capture();
  await scripted(first.integration);
  await scripted(second.integration);
  await first.observer.flush();
  await second.observer.flush();
  const ids = (body: OtlpPayload) =>
    spansIn(body).map(({ traceId, spanId, parentSpanId }) => ({ traceId, spanId, parentSpanId }));
  expect(ids(first.bodies[0])).toEqual(ids(second.bodies[0]));
  const root = spansIn(first.bodies[0])[0];
  expect(root.traceId).toBe(
    createHash("sha256")
      .update(JSON.stringify([facts.runId, facts.turnKey]))
      .digest("hex")
      .slice(0, 32),
  );
  expect(new Set(spansIn(first.bodies[0]).map((span) => span.spanId)).size).toBe(6);
  const other = capture();
  await scripted(other.observer.integration({ ...facts, turnKey: "other" }));
  await other.observer.flush();
  expect(spansIn(other.bodies[0])[0].traceId).not.toBe(root.traceId);
});

it("integration instances with identical facts allocate unique, deterministic span ids", async () => {
  const first = capture();
  const replay = capture();
  for (const { observer } of [first, replay]) {
    const integrations = Array.from({ length: 3 }, () => observer.integration(facts));
    await Promise.all(integrations.map((integration) => scripted(integration)));
    await observer.flush();
  }
  const spans = spansIn(first.bodies[0]);
  expect(spans).toHaveLength(18);
  expect(new Set(spans.map((span) => span.spanId)).size).toBe(spans.length);
  expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
  const ancestry = (body: OtlpPayload) =>
    spansIn(body).map(({ spanId, parentSpanId }) => ({ spanId, parentSpanId }));
  expect(ancestry(first.bodies[0])).toEqual(ancestry(replay.bodies[0]));
  for (const root of spans.filter((span) => !span.parentSpanId)) {
    expect(spans.filter((span) => span.parentSpanId === root.spanId)).toHaveLength(2);
  }
});

it("concurrent SDK calls keep separate span ancestry", async () => {
  const { observer, integration, bodies } = capture();
  await Promise.all([scripted(integration), scripted(integration)]);
  await observer.flush();
  const spans = spansIn(bodies[0]);
  const roots = spans.filter((span) => !span.parentSpanId);
  expect(roots).toHaveLength(2);
  for (const root of roots) {
    const steps = spans.filter((span) => span.parentSpanId === root.spanId);
    expect(steps).toHaveLength(2);
    expect(steps.every((span) => span.name.startsWith("step "))).toBe(true);
    const chats = spans.filter((span) => steps.some((step) => step.spanId === span.parentSpanId));
    expect(chats).toHaveLength(2);
    expect(
      spans.filter((span) => chats.some((chat) => chat.spanId === span.parentSpanId)),
    ).toHaveLength(1);
  }
});

it("hard span and encoded UTF-8 attribute ceilings truncate with a marker and retain valid ancestry", async () => {
  const { observer, integration, bodies } = capture({ recordInputs: true, recordOutputs: true });
  for (let index = 0; index < LIMITS.maxSpansPerTurn; index++)
    await scripted(integration, {
      input: "😀\u0000".repeat(LIMITS.maxValueBytes),
      output: "é".repeat(LIMITS.maxValueBytes),
    });
  await observer.flush();
  const spans = spansIn(bodies[0]);
  expect(spans).toHaveLength(LIMITS.maxSpansPerTurn);
  validateOtlp(bodies[0]);
  expect(attributesOf(spans[0])["agevex.truncated"]).toBe(true);
  expect(JSON.stringify(bodies)).toContain("[truncated]");
  for (const span of spans) {
    expect(byteSize(span.attributes)).toBeLessThanOrEqual(LIMITS.maxAttributeBytes);
    if (span.parentSpanId)
      expect(spans.some((parent) => parent.spanId === span.parentSpanId)).toBe(true);
    for (const { value } of span.attributes)
      if ("stringValue" in value)
        expect(byteSize(value.stringValue)).toBeLessThanOrEqual(LIMITS.maxValueBytes);
  }
  expect(byteSize(bodies[0])).toBeLessThan(2.25 * 1024 * 1024);
});

it("the attribute-list ceiling counts JSON escaping and reserves its truncation marker", async () => {
  const { observer, integration, bodies } = capture({
    recordInputs: true,
    recordOutputs: true,
    sanitize: () => "x".repeat(LIMITS.maxValueBytes - 2),
  });
  await scripted(integration);
  await observer.flush();
  const spans = spansIn(bodies[0]);
  expect(spans.some((span) => attributesOf(span)["agevex.truncated"] === true)).toBe(true);
  for (const span of spans)
    expect(byteSize(span.attributes)).toBeLessThanOrEqual(LIMITS.maxAttributeBytes);
});

it("flush is one-shot and never repeats an exporter after an unknown failure", async () => {
  const exporter = vi.fn(() => {
    throw new Error("unknown ingestion outcome");
  });
  const { observer, integration } = capture({ exporters: [{ export: exporter }] });
  await scripted(integration);
  await expect(observer.flush()).resolves.toBeUndefined();
  await expect(observer.flush()).resolves.toBeUndefined();
  expect(exporter).toHaveBeenCalledTimes(1);
});

it("hung exporters are aborted at three seconds even when they ignore the signal", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const { observer, integration } = capture({
    exporters: Array.from({ length: LIMITS.maxExporters }, () => ({
      export: (_: OtlpPayload, current?: AbortSignal) => {
        if (current) signals.push(current);
        return new Promise<void>(() => {});
      },
    })),
  });
  await scripted(integration);
  const flushing = observer.flush();
  await vi.waitFor(() => expect(signals).toHaveLength(LIMITS.maxExporters));
  await vi.advanceTimersByTimeAsync(LIMITS.exportTimeoutMs);
  await expect(flushing).resolves.toBeUndefined();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it("caller cancellation ends a pending export and a pre-aborted flush sends nothing", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const { observer, integration } = capture({
    exporters: [
      {
        export: (_, signal) => {
          received = signal;
          return new Promise<void>(() => {});
        },
      },
    ],
  });
  await scripted(integration);
  const flushing = observer.flush(controller.signal);
  await vi.waitFor(() => expect(received).toBeDefined());
  controller.abort();
  await expect(flushing).resolves.toBeUndefined();
  expect(received?.aborted).toBe(true);
  const aborted = capture();
  await scripted(aborted.integration);
  await aborted.observer.flush(controller.signal);
  expect(aborted.bodies).toHaveLength(0);
});

it("provider errors close the affected call as failed without exporting its raw diagnostic", async () => {
  const { observer, integration, bodies } = capture();
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: () => {
        throw new Error("private provider error");
      },
    }),
    prompt: "private prompt",
    maxRetries: 0,
    onError: () => {},
    telemetry: { integrations: [integration] },
  });
  await result.consumeStream();
  await observer.flush();
  expect(spansIn(bodies[0])[0].status.code).toBe(2);
  expect(JSON.stringify(bodies)).not.toContain("private");
});

const failureUsage: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
it.each(["stop", "length", "content-filter", "other"] as const)(
  "completed streams with finish reason %s retain OK spans",
  async (finishReason) => {
    const { observer, integration, bodies } = capture();
    await scripted(integration, { finishReason });
    await observer.flush();
    expect(spansIn(bodies[0])).toHaveLength(6);
    expect(spansIn(bodies[0]).every((span) => span.status.code === 1)).toBe(true);
  },
);
it.each([
  ["provider error chunks", [{ type: "error", error: new Error("private provider error") }]],
  [
    "error finish reasons",
    [
      {
        type: "finish",
        finishReason: { unified: "error", raw: "private failure" },
        usage: failureUsage,
      },
    ],
  ],
  ["incomplete streams with partial text", []],
  [
    "interrupted finish reasons",
    [
      {
        type: "finish",
        finishReason: { unified: "interrupted", raw: "private interruption" },
        usage: failureUsage,
      },
    ],
  ],
] satisfies [string, LanguageModelV4StreamPart[]][])(
  "%s mark model, step and agent spans ERROR with a safe reason",
  async (_, ending) => {
    const { observer, integration, bodies } = capture();
    const result = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              for (const part of [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "text" },
                { type: "text-delta", id: "text", delta: "private partial output" },
                ...ending,
              ] satisfies LanguageModelV4StreamPart[])
                controller.enqueue(part);
              controller.close();
            },
          }),
        }),
      }),
      prompt: "private prompt",
      maxRetries: 0,
      onError: () => {},
      telemetry: { integrations: [integration] },
    });
    await result.consumeStream();
    await observer.flush();
    const spans = spansIn(bodies[0]);
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      expect(span.status).toMatchObject({ code: 2, message: expect.any(String) });
      expect(span.status.message).not.toBe("");
    }
    expect(JSON.stringify(bodies)).not.toContain("private");
  },
);

it("Langfuse POSTs validated OTLP JSON with v4 ingestion and portable UTF-8 Basic auth", async () => {
  const request = vi.fn(async () => new Response(null, { status: 200 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(request);
  vi.stubGlobal("btoa", undefined);
  try {
    const { observer, integration } = capture({
      exporters: [
        langfuse({
          baseUrl: "https://langfuse.example/",
          publicKey: "püblic",
          secretKey: "secret",
        }),
      ],
    });
    await scripted(integration);
    await observer.flush();
    const [url, init] = request.mock.calls[0] as unknown as Parameters<typeof fetch>;
    expect(url).toBe("https://langfuse.example/api/public/otel/v1/traces");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from("püblic:secret").toString("base64")}`,
      "x-langfuse-ingestion-version": "4",
    });
    validateOtlp(JSON.parse(init?.body as string));
  } finally {
    vi.unstubAllGlobals();
  }
});

it("Braintrust exports the same OTLP payload to its OTel endpoint with project routing", async () => {
  const request = vi.fn(async () => new Response(null));
  vi.spyOn(globalThis, "fetch").mockImplementation(request);
  const { observer, integration } = capture({
    exporters: [braintrust({ apiKey: "key", projectId: "project" })],
  });
  await scripted(integration);
  await observer.flush();
  const [url, init] = request.mock.calls[0] as unknown as Parameters<typeof fetch>;
  expect(url).toBe("https://api.braintrust.dev/otel/v1/traces");
  expect(init?.headers).toMatchObject({
    Authorization: "Bearer key",
    "x-bt-parent": "project_id:project",
  });
  validateOtlp(JSON.parse(init?.body as string));
});

it.each([400, 401, 413, 500])("HTTP %s is fail-open and never retried", async (status) => {
  const request = vi.fn(async () => new Response(null, { status }));
  vi.spyOn(globalThis, "fetch").mockImplementation(request);
  const { observer, integration } = capture({
    exporters: [
      langfuse({ baseUrl: "https://langfuse.example", publicKey: "pk", secretKey: "sk" }),
    ],
  });
  await scripted(integration);
  await expect(observer.flush()).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});

it("direct exporter calls swallow network errors and enforce the three-second HTTP deadline", async () => {
  const { observer, integration, bodies } = capture();
  await scripted(integration);
  await observer.flush();
  const exporter = langfuse({
    baseUrl: "https://langfuse.example",
    publicKey: "pk",
    secretKey: "sk",
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  await expect(exporter.export(bodies[0])).resolves.toBeUndefined();
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.mocked(fetch).mockImplementation((_, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  const sending = exporter.export(bodies[0]);
  await vi.advanceTimersByTimeAsync(LIMITS.exportTimeoutMs);
  await expect(sending).resolves.toBeUndefined();
  expect(signal?.aborted).toBe(true);
});

it("invalid registration and facts fail before attaching telemetry", () => {
  expect(() =>
    telemetry({
      exporters: Array.from({ length: LIMITS.maxExporters + 1 }, () => ({ export() {} })),
    }),
  ).toThrow("exporters");
  const observer = telemetry({ exporters: [] });
  expect(() => observer.integration({ ...facts, subject: "" })).toThrow("subject");
  expect(() =>
    observer.integration({ ...facts, turnKey: "é".repeat(LIMITS.maxFactBytes) }),
  ).toThrow("turnKey");
  expect(() =>
    langfuse({ baseUrl: "file:///tmp/trace", publicKey: "pk", secretKey: "sk" }),
  ).toThrow("baseUrl");
  expect(() => braintrust({ apiKey: "", projectId: "project" })).toThrow("apiKey");
});

it("aborted streamText calls close as errors without recording the abort reason", async () => {
  const controller = new AbortController();
  const { observer, integration, bodies } = capture();
  const result = streamText({
    model: new MockLanguageModelV4(),
    prompt: "private prompt",
    maxRetries: 0,
    abortSignal: controller.signal,
    onStepStart: () => controller.abort(new Error("private abort reason")),
    onError: () => {},
    telemetry: { integrations: [integration] },
  });
  await result.consumeStream();
  await observer.flush();
  expect(spansIn(bodies[0])[0].status.code).toBe(2);
  expect(JSON.stringify(bodies)).not.toContain("private");
});

it("empty buffers send nothing and flushing an active stream marks unfinished spans as errors", async () => {
  const empty = capture();
  await empty.observer.flush();
  expect(empty.bodies).toHaveLength(0);
  const { observer, integration, bodies } = capture();
  let started: () => void = () => {};
  let closeProvider: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const result = streamText({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            closeProvider = () => controller.close();
            started();
          },
        }),
      }),
    }),
    prompt: "prompt",
    maxRetries: 0,
    onError: () => {},
    telemetry: { integrations: [integration] },
  });
  // Drive the lazy stream until the provider has actually started, then flush
  // early to exercise finally cleanup after an interrupted/unfinished operation.
  const reader = result.fullStream.getReader();
  const reading = reader.read();
  await ready;
  await observer.flush();
  expect(spansIn(bodies[0]).every((span) => span.status.code === 2)).toBe(true);
  expect(spansIn(bodies[0]).every((span) => !!span.status.message)).toBe(true);
  closeProvider();
  await reading;
  await reader.cancel();
});

it("maximum escaped facts remain present on every span within the byte ceiling", async () => {
  const { observer, bodies } = capture();
  const maximum = "\u0000".repeat(LIMITS.maxFactBytes);
  const identity = Object.fromEntries(
    Object.keys(facts).map((key) => [key, maximum]),
  ) as typeof facts;
  await scripted(observer.integration(identity));
  await observer.flush();
  for (const span of spansIn(bodies[0])) {
    expect(attributesOf(span)).toMatchObject({
      "langfuse.session.id": maximum,
      "langfuse.user.id": maximum,
      "langfuse.trace.name": maximum,
      "langfuse.trace.metadata.thread_id": maximum,
      "langfuse.trace.metadata.run_id": maximum,
      "langfuse.trace.metadata.agent": maximum,
      "langfuse.trace.metadata.turn_key": maximum,
    });
    expect(byteSize(span.attributes)).toBeLessThanOrEqual(LIMITS.maxAttributeBytes);
  }
});
