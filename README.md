# agevex

A Convex component package: a **Workpool-backed** managed runtime for native
Convex Agents, with a bounded, depth-1 delegation path.

The native Agent component keeps owning threads, messages, tools, generation and
streaming. Agevex adds authorized message acceptance, persisted scheduling and
coordination state, and a bounded asynchronous delegation path. It never creates
a second transcript, and it does not require Workflow.

- Repository: <https://github.com/pixelscortex/agevex>
- API contract and remaining proposals: [`docs/public-api-proposal.md`](docs/public-api-proposal.md)
- Component design and tables: [`src/component/README.md`](src/component/README.md)

## Status

This package is **private** (`"private": true`) and **UNLICENSED**. It is not
published to npm and carries no open-source license grant. The repository is
the distribution channel.

## What is implemented

| Surface                          | What it is                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `Agent`                          | Additive subclass of the native Agent. Native behavior is unchanged.          |
| `registerAgevex`                 | One host registration: the managed runtime and its two internal entry points. |
| `open` / `send`                  | Authorized acceptance of work. They return a receipt, never generated text.   |
| `messages`                       | Authorized wrapper preserving native pagination and native stream sync.       |
| `activity`                       | Authorized read of one thread's coordination state.                           |
| `delegations`                    | Authorized newest-first page of one root's delegated child runs.              |
| `agevex_delegate` + `coordinate` | The reserved managed tool and the only extra host entry point.                |

`src/component` mounts **Workpool only** — not the native Agent component and
not a Workflow. `src/test.ts`, exported as `agevex/test`, registers the
component for `convex-test`.

## Stable bounds

These are the implemented bounds, not aspirations. They live in
`src/component/limits.ts` and are shared by the component and the host runtime.

| Bound                                            | Value       |
| ------------------------------------------------ | ----------- |
| Delegation depth                                 | 1           |
| Children launched per accepted user prompt       | 3           |
| Concurrent active child runs per root            | 5           |
| Shared Workpool parallelism (roots and children) | 4           |
| Output tokens per managed generation             | 4096        |
| Cooperative generation abort                     | 90 s        |
| Claim-armed execution watchdog                   | 120 s       |
| `agevex_delegate` task length                    | 4000 chars  |
| Delegations page size                            | 20 / 50 max |

A managed turn runs exactly **one** model step, and neither the AI SDK nor the
Workpool retries a generation (`maxRetries: 0`).

## Mount and register

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import nativeAgent from "@convex-dev/agent/convex.config";
import agevex from "agevex/convex.config";

const app = defineApp();
app.use(nativeAgent, { name: "agent" });
app.use(agevex);
export default app;
```

```ts
// convex/agents.ts
import { Agent, registerAgevex, type TurnArgs } from "agevex";
import type { FunctionReference, RegisteredAction } from "convex/server";
import { components, internal } from "./_generated/api.js";

const main = new Agent(components.agent, {
  name: "Main",
  languageModel: yourHostOwnedModel,
  subagents: [],
});

const runtime = registerAgevex(components.agevex, {
  // Only roots are public. A child is resolved through its root's `subagents`.
  agents: [main],
  refs: {
    runTurn: (): FunctionReference<"action", "internal", TurnArgs, null> => internal.agents.runTurn,
    // Required only when a root declares `subagents`.
    coordinate: (): FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult> =>
      internal.agents.coordinate,
  },
  authorize: hostPolicy,
  authorizeExecution: hostExecutionPolicy,
});

export const runTurn: RegisteredAction<"internal", TurnArgs, null> =
  runtime.internalFunctions().runTurn;
export const { open, send, messages, activity, delegations } = runtime.authorizedEndpoints();
```

`Agent` adds exactly one thing to the native Agent: `subagents`. It declares
the delegation graph as **real `Agent` objects**, not names, and the runtime
resolves the executable child through that list. A child declares
`subagents: []`, so managed depth is 1 and a child can never delegate.

There is **no** `runChildTurn` entry point and **no** third authorization
callback. A child turn is an ordinary managed turn dispatched through `runTurn`.

## Mandatory host authorization

The host supplies two callbacks, and both are required:

- `authorize(ctx, scope)` runs for every public read and write (`open`, `send`,
  `messages`, `activity`, `delegations`) and for the two background operations
  (`delegate`, `deliver`). It returns the trusted `{ subject }`; the runtime
  compares it with persisted ownership. `delegate` and `deliver` act with no end
  user on the connection, so `ctx.auth` may be `null` there and the policy must
  branch explicitly and recheck the stored principal against current policy.
  Echoing the supplied subject back is not authorization.
- `authorizeExecution(actionCtx, scope)` rechecks the trusted persisted scope
  immediately before **every** managed generation, including a child turn and a
  result-triggered continuation.

`subagents: []` with only `refs.runTurn` remains a supported root-only
registration.

## Asynchronous semantics

- `open` and `send` return an **acceptance receipt** immediately. The client
  call is not held open until the model finishes.
- Deduplication is keyed on the trusted `subject + requestKey`. An identical
  operation, target and body replays the original receipt; changed input is a
  conflict, detected before any native thread or message write.
- Accepted work queues while its recipient is busy. Messages that arrive during
  a running turn never silently enter that turn's context.
- The `agevex_delegate` tool returns as soon as the child is **queued**. It
  never waits for the child, never consumes the parent's execution slot, and
  never takes over the native transcript. The child's result is delivered into
  the parent thread **later**, as a native message in a separate turn.
- Delivery `accepted` means the native parent message and the component backlog
  both committed. It is not a read receipt, not an acknowledgement, and not an
  exactly-once guarantee about provider, model or tool effects.
- Every assignment — root and child — stays `open` forever. A finished turn is
  not a finished task, and a terminal child run never changes its root's
  status.

## Not implemented

Explicit assignment completion and any host completion check; a general
coordination engine, peer-to-peer agent messaging, a review engine, or agents
delegating to their own children; delegation deeper than one level; more than
five concurrent children per root or more than three per accepted user prompt;
Workflow-based continuation; recovery or repair APIs; and any transcript or
hook that replaces native `useUIMessages`.

## Development

Bun 1.4.3, Vite+ and the official Convex rules through Oxlint. The Convex CLI
is only needed to regenerate the component's bindings.

```bash
bun install --frozen-lockfile
bun run typecheck          # the library's own sources, strictly NodeNext
bun run typecheck:tests    # the component tests and the test fixture
bun x vp test --run        # deterministic convex-test suite; no provider, no network
bun run build              # build the package into dist/
bun run fmt:check
bun run lint               # Oxlint through Vite+, warnings are errors
bun run lint:convex:check  # proves the Convex rules really run
bun run check              # format + lint + the Convex rule probe
bun run codegen            # regenerate src/component/_generated (needs a Convex project)
```

`src/client` exports `Agent`, `registerAgevex` and the public types.
`src/component` owns the receipt, assignment, pending and `subagentRuns` state
and mounts Workpool. `tests/` holds the component tests and the deterministic
host fixture they run against; no provider, key or network is involved.
`src/component/_generated/**` is genuine `convex codegen` output and is
tracked — never hand-edit it.

## License

`UNLICENSED`. All rights reserved; there is no open-source license grant.
