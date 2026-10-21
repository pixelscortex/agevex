# Agevex observability

Agevex exposes an optional metadata-only lifecycle hook. It is deliberately a
small seam rather than a built-in analytics vendor integration.

## Register the hook

```ts
import { registerAgent } from "agevex";

const runtime = registerAgent(components.agevex, {
  agents: [main],
  refs,
  authorize,
  authorizeExecution,
  observe: async (ctx, event) => {
    await ctx.runMutation(internal.analytics.recordAgentEvent, { event });
  },
});
```

The host callback runs in the same Convex function context as the operation that
produced the event. Keep it synchronous and enqueue durable recording with a
host scheduler. Do not perform network I/O or await a long-running operation in
the callback.

## Event contract

The public `AgentEvent` union currently includes:

- `request.accepted`
- `request.replayed`
- `turn.claimed`
- `turn.finished`
- `delegation.queued`
- `delegation.replayed`
- `delegation.settled`
- `delegation.delivered`

See the exported `AgentEvent` union for the exact shape. Events contain
operational metadata such as subject, assignment, thread, agent, run, operation,
outcome, and sanitized error codes. They intentionally do not contain prompt
text, model output, tool arguments, result bodies, capabilities, or delivery
tokens.

## Failure semantics

Observation is best effort and is not awaited by Agevex. If the host callback
throws or its returned promise rejects, Agevex swallows that failure and
continues the managed request, generation, delegation, or delivery. A callback
must schedule its own durable write synchronously; it must not hold the Convex
transaction open. This prevents an analytics outage from replaying paid work or
changing the execution result.

## External analytics

The core package does not depend on Braintrust, Langfuse, or another vendor.
Hosts can translate `AgentEvent` records into their own analytics ledger or
OpenTelemetry spans. Model-level telemetry can be added through the AI SDK
integration used by the host; Agevex lifecycle events cover the execution,
tool, and delegation boundaries that model telemetry does not describe.
