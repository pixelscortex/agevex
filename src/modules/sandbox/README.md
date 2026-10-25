# Sandbox

An optional Convex component and host client for persistent sandbox files,
bounded commands, background jobs and binary exports. Core never imports it.
The component stores identities, claims and deadlines; provider credentials,
commands and file bodies stay on the host or provider side.

Mount `agevex/sandbox/convex.config` in the host’s Convex config. Import
`defineSandbox`, `daytona` and `sandboxCompletion` from `agevex/sandbox`.
Pass the mounted component, provider, scope and host `authorize` callback to
`defineSandbox`. For background jobs, supply lazy `refs` to the host’s exported
`wake`, `poll`, `settle` and `cleanup` functions from `sandbox.internalFunctions()`.

Wire `sandbox.slot()` into `registerAgent({ sandbox: sandbox.slot(), ... })` and
opt individual agents in with `sandbox: true`. Use
`onComplete: sandboxCompletion(() => runtime)` to deliver terminal jobs to the
root conversation. Standalone hosts can use `sandbox.tools(context)` directly.

Binary export also needs the native Agent component through `agent`. Run-scoped
exports need a trusted `resolveThread`. For larger files, export
`sandboxNodeExport(options)` from a host `"use node"` file and pass its reference
as `nodeExport`. Cleanup is explicitly invoked; mounting creates no timer.

| File                          | Responsibility                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `component/state.ts`          | Stable registered `state.*` queries and mutations; runs in Convex.                       |
| `component/admission.ts`      | Transactional sandbox/job admission and complete row builders.                           |
| `component/state-helpers.ts`  | Indexed lookups, active-job probes, safe wake cancellation and terminal transitions.     |
| `component/schema.ts`         | Scope bindings in `sandboxes`; fenced finite watchdogs in `jobs`.                        |
| `component/convex.config.ts`  | Optional component declaration.                                                          |
| `component/_generated/`       | Component API and data-model types.                                                      |
| `client/index.ts`             | Host factory, public exports and core completion adapter.                                |
| `client/runtime-context.ts`   | Validated context, attribution, authorization, action deadlines and usage observations.  |
| `client/lifecycle.ts`         | Prepare, stop, delete, cleanup scheduling and reconciliation reads.                      |
| `client/execution.ts`         | Bounded commands and persist-before-launch background jobs.                              |
| `client/files.ts`             | Bounded text reads, writes and directory listings.                                       |
| `client/tools.ts`             | SDK tools, once-tool bindings and root-conversation slot.                                |
| `client/watchdog.ts`          | Host wake/poll/settle/cleanup builders and bounded status/kill decisions.                |
| `client/export.ts`            | Existing-filesystem authorization, windowed downloads, hashing and native Agent storage. |
| `client/daytona.ts`           | Public Daytona adapter factory.                                                          |
| `client/daytona-context.ts`   | SDK context and bounded Python transport.                                                |
| `client/daytona-lifecycle.ts` | Create, recover/resume, stop and delete builders.                                        |
| `client/daytona-process.ts`   | Command supervision, background launch, status and ownership-checked cancellation.       |
| `client/daytona-files.ts`     | Source-bounded file operations and staged binary windows.                                |
| `client/types.ts`             | Host/provider contracts and callback types.                                              |
| `shared/limits.ts`            | Pure bounds and validation shared by host and component.                                 |
| `test.ts`                     | Offline convex-test component registration.                                              |

A use reserves its scope, persists the provider identity, resumes it and checks
its claim again. Background admission persists the reconciliation location and
watchdog before launch. Wake claims and schedules atomically; safe status reads
retry until the deadline, while uncertain paid commands never replay. Settlement
and the host completion callback commit together. The last terminal job rearms
idle cleanup; an uncertain delete remains available for host reconciliation.
