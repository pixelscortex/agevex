# agevex

A Workflow-backed Convex component and host client for managed
`@convex-dev/agent` agents. Native Agent owns threads, messages, tools and
streaming. Agevex owns durable scheduling, authorization, depth-1 delegation,
run budgets and idempotency.

Git-only, private package, **UNLICENSED**.

## Setup

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import agent from "@convex-dev/agent/convex.config";
import agevex from "agevex/convex.config";
const app = defineApp();
app.use(agent);
app.use(agevex);
export default app;
```

```ts
// convex/agents.ts
import { Agent, registerAgent } from "agevex";
import { components, internal } from "./_generated/api.js";

const researcher = new Agent(components.agent, {
  name: "Researcher",
  languageModel,
  subagents: [],
});
const main = new Agent(components.agent, {
  name: "Main",
  languageModel,
  subagents: [researcher],
});
const runtime = registerAgent(components.agevex, {
  agents: [main],
  refs: {
    runTurn: () => internal.agents.runTurn,
    coordinate: () => internal.agents.coordinate,
  },
  authorize: hostPolicy,
  authorizeExecution: hostExecutionPolicy,
});
export const { runTurn, coordinate } = runtime.internalFunctions();
export const { open, send, respond, cancel, messages, activity, delegations } =
  runtime.authorizedEndpoints();
```

`languageModel`, `hostPolicy` and `hostExecutionPolicy` are host-owned. For
Convex generated-reference inference cycles, annotate `runTurn` with
`RegisteredAction<"internal", TurnArgs, null>` and `coordinate` with
`RegisteredMutation<"internal", CoordinateArgs, CoordinateResult>` from
`convex/server`; the argument/result types are exported by `agevex`.
A root without children only needs `refs.runTurn`.

## Durable execution

`open({ agent, prompt, requestKey })` and
`send({ threadId, text, requestKey })` return acceptance receipts immediately.
Identical subject-scoped keys replay the receipt; different input throws
`KEY_CONFLICT` before native writes. Up to 20 additional prompts queue while
busy. Arrivals never silently enter an ongoing turn.

Each thread has a component-internal loop workflow. It reads the durable
`inbox`, starts turn child workflows, then sleeps on `awaitEvent("ping")`.
Pings are doorbells; inbox rows own the work. Shared, batched reconciliation
checks idle loops every 30 seconds, recovering lost doorbells. Each turn runs
at most 16 slices,
one native model step per action. Paid work uses `maxRetries: 0` and
`retry: false`. Only ids and control values enter the workflow journal.

Root and child lanes have 2 and 4 slots respectively, within the starter
plan's 8 scheduled-job slots. Delegation returns immediately and releases the
parent action slot. Consecutive results from already-launched children batch
into one parent continuation. Every workflow carries a version argument;
step order is protected by replay fixtures.

A user prompt starts one run. Its turns and child results share a budget of
12 launches / 24 hops (launches plus delivered results). Result turns may
call `agevex_delegate` again. Over budget returns
`{ status: "denied", code: "RUN_BUDGET" }`. Depth remains 1, with at most
5 active children per root and 4000 characters per delegated task.

Failures are sanitized and never automatically replayed. Ambiguous execution
sets `recovery_required`; the watchdog covers each active slice, excluding
queue and between-slice time.

## Cancellation and approvals

`cancel({ threadId })` is owner-authorized and root-only. It increments the
epoch, cancels root/child workflows and clears queued work. Running actions
poll about once a second and abort their signal. Native and managed-tool
mutations check execution id plus epoch atomically; late writes are dropped.
after cancel, the SDK refuses new nested calls and drops its own writes; writes your own code makes inside an already-running nested action are yours to guard with `tc.signal`.
A fresh `send` can start new work after cancellation. External effects already
accepted by a provider still depend on that provider's abort behavior.

Pending native tool approvals block generation and leave the inbox row
waiting, avoiding Agent 0.7.7's automatic denial on a new generation.
Approval responses must go through `respond({ threadId, approvalId, approved, reason? })`; a response saved directly through the Agent component is not seen by the runtime.

## Effects that must run once

```ts
import { defineOnceTool } from "agevex";
import { z } from "zod";

const charge = defineOnceTool({
  name: "charge",
  input: z.object({ orderId: z.string() }),
  key: (input) => input.orderId, // defaults to the native toolCallId
  run: (input, tc) =>
    hostCharge(input.orderId, {
      subject: tc.subject,
      signal: tc.signal,
    }),
});
```

Add the tool to the Agent's `tools`. Its context contains `ctx`, `subject`,
`threadId`, `runId`, `toolCallId` and `signal`. Tools own their permissions.
The receipts ledger fingerprints inputs and caches bounded results. Reused
keys with different input return `KEY_CONFLICT`; expired 10-minute leases
become `unknown`, with no silent rerun. Declare `repeatSafe: true` only when
repeating an abandoned effect is safe. `leaseMs` overrides the lease. Results
must fit 64 KiB; return a storage reference for larger payloads. Expired
receipts are purged in scheduled batches after seven days.

## Reads, policy and limits

`messages({ threadId, paginationOpts, streamArgs? })` reads roots and children
with native pagination and stream sync. Find `childThreadId` in `delegations`.
`activity` and `delegations` are root coordination reads. Public sends and
cancels cannot drive a child's lifecycle.

`authorize` checks public ownership and background `delegate`/`deliver`
operations. Background calls may have no authenticated connection: recheck the
stored subject against current host policy. `authorizeExecution` runs before
every model slice. Optional `observe` receives metadata-only lifecycle events;
observer failures do not change execution.

`LIMITS`, exported from `agevex`, is the single source of runtime bounds,
including lane sizes, model output/deadline, slices, run budgets, queue size,
ledger retention. Registration accepts `limits?: Partial<Limits>` for lanes,
run budgets, active children, task/queue size, slices and lease; positive
integers are required and lanes must fit scheduled concurrency. Registrations
sharing a component mount share its lane capacities. `PLATFORM` contains
documented facts, not checked by the SDK, including Workflow journal/step
ceilings (8 MiB / 800 KiB). Workflow enforces those byte limits.

## Development

```sh
bun install --frozen-lockfile
bun run test                  # scripted models, no network
bun run test:live             # skips without OPENROUTER_API_KEY
bun run check
bun run typecheck
bun run typecheck:tests
bun run build
```

Live tests use OpenRouter, default `OPENROUTER_LIVE_MODEL=openrouter/free`,
with a small request bound and a default $0.05 spend cap
(`OPENROUTER_LIVE_MAX_USD`). Routed models, tokens and provider cost are saved
in `.vite-plus/live-results.json`. `agevex/test` exports `register`,
`scriptedModel` and `expectJournalUnchanged`; the latter checks committed
journals and replays them through the real Workflow engine.

See [component ownership](src/component/README.md). Deferred: deeper delegation,
groups/joins, peer messaging, approval UX, hooks, meter and other optional
modules. No migration is supplied for this pre-adoption schema change.
