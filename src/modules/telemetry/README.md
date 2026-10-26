# telemetry

Optional host library that observes AI SDK calls and exports bounded OTLP JSON.
It runs inside the host action alongside agevex, with no Convex component, tables,
transcript reads, durable outbox or automatic retries.

Wire `telemetry.slot({ exporters: [langfuse({ baseUrl, publicKey, secretKey })] })`
from `agevex/telemetry` into `registerAgent`'s `telemetry` slot. Configuration may
be shared: each opaque turn key gets its own buffer, and core flushes it in
`finally` with its cancellation/deadline signal. Hosts can also call
`telemetry(options)`, attach `observer.integration(facts)` to AI SDK telemetry,
consume the stream, and `await observer.flush()` in `finally`.

Exporter keys take a string or a getter such as `() => process.env.LANGFUSE_SECRET_KEY!`;
a getter runs at each export, never at construction. The non-secret settings take
the same shape: `braintrust({ projectId })` and `langfuse({ baseUrl })` accept a
string (validated at construction) or a getter (validated when it resolves). A
missing, empty, oversized or invalid resolved value sends nothing for that export
and never fails the agent.

`telemetry.slot({ enabled })` switches tracing off per deployment. `enabled` is a
boolean or a sync/async getter (default `true`), resolved once per turn when that
turn's buffer is created (its first integration), so a getter can read env inside
the handler and never runs at registration. When it resolves to anything but
`true` (including a throw, rejection or a getter slower than three seconds), the
turn records no spans and runs no exporter: nothing is buffered and no request is
made. A sync getter adds no asynchrony; an async one makes the turn's model
callbacks wait for its answer, bounded by that three-second deadline.

Content recording is off by default. Enable `recordInputs`/`recordOutputs`
explicitly and provide `sanitize` for host redaction; SDK recording opt-outs still
apply. Exporters fail open and never retry unknown outcomes. Each turn admits at
most 128 spans with 16 KiB encoded attributes each: the complete request stays
below 2.25 MiB. Up to four exporters run concurrently with a three-second bound
(or core's signal). Stable ids preserve ancestry across retries; ingestion can
still duplicate a retried action's export.

File map (all under `client/`):

- `index.ts`: stable public exports, standalone entry point and keyed registration slot.
- `types.ts`: public contracts and explicit turn/integration buffer contexts.
- `turn.ts`: validated action buffer construction and entry-point composition.
- `attribution.ts`: fact validation, oversized-fact digests and span-name sanitization.
- `integration.ts`: guarded SDK callback composition; sealed buffers ignore later events.
- `agent-events.ts`: agent/step lifecycle, completion, abort and safe error attribution.
- `model-events.ts`: model attempts, usage and opt-in model content.
- `tool-events.ts`: matching tool spans, inputs and successful results.
- `spans.ts`: bounded span admission, attributes, ancestry and completion bookkeeping.
- `flush.ts`: synchronous seal, digest resolution, stable ids and one-shot export.
- `enabled.ts`: call-time on/off switch, resolved once per turn and failing closed.
- `credential.ts`: literal-or-getter credentials and non-secret exporter settings.
- `exporters.ts`: Langfuse/Braintrust HTTP adapters and abort/deadline races.
- `otlp.ts`: portable OTLP encoding, bounded attribute writer and WebCrypto hashing.
- `limits.ts`: hard ceilings, UTF-8 bounds and defensive value traversal.
