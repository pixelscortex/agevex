# Host telemetry adapter

`client/index.ts` exports `telemetry({ integration, flush? }): TelemetrySlot`,
`TelemetryOptions` and `TelemetryFacts`. `integration` is an AI SDK 7 `Telemetry`
or a synchronous `(facts) => Telemetry` factory. `flush(facts, signal?)` belongs
to the host; core's final flush is bounded to three seconds, including exporters
that ignore abort.

Every callback receives frozen trusted facts on `event.agevex`: subject, root
thread, thread, run, agent, turn key, and optional purpose/node. The factory gets
the same snapshot for exporter-specific metadata. Sync throws, rejected callbacks,
getter errors and flush failures cannot fail a turn. Wrapped model/tool execution
is memoized, including failures, so telemetry errors cannot replay paid work.

The host supplies exporter dependencies, credentials, spans, content controls,
sanitization, buffers and delivery policy. agevex stores no telemetry state.
See `docs/site/content/docs/modules/telemetry.mdx` for Braintrust wiring.
