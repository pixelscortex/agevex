# Sandbox

An optional Convex component and host client for persistent sandbox files,
bounded commands, background jobs and binary transfers. Core never imports it.
The component stores identities, claims and deadlines; provider credentials,
commands and file bodies stay on the host or provider side.

Mount `agevex/sandbox/convex.config` in the host’s Convex config. Import
`defineSandbox`, `daytona` and `sandboxCompletion` from `agevex/sandbox`.
Pass the mounted component, provider, scope and host `authorize` callback to
`defineSandbox`. For background jobs, supply lazy `refs` to the host’s exported
`wake`, `poll`, `settle` and `cleanup` functions from `sandbox.internalFunctions()`.

`daytona(component, { apiKey })` accepts a string or a getter such as
`() => process.env.DAYTONA_API_KEY!`; a getter runs at each Daytona call, never at
construction. Omit `apiKey` to keep the SDK's call-time `DAYTONA_API_KEY` fallback.

Wire `sandbox.slot()` into `registerAgent({ sandbox: sandbox.slot(), ... })` and
opt individual agents in with `sandbox: true`. Use
`onComplete: sandboxCompletion(() => runtime)` to deliver terminal jobs to the
root conversation. Standalone hosts can use `sandbox.tools(context)` directly.

Binary export also needs the native Agent component through `agent`. Run-scoped
exports need a trusted `resolveThread`. For larger files, export
`sandboxNodeExport(options)` from a host `"use node"` file and pass its reference
as `nodeExport`. Cleanup is explicitly invoked; mounting creates no timer.

`sandbox.writeBytes(ctx, { subject, threadId, runId, path, source, maxBytes? })`
accepts host-owned scope facts and either `source: { storageId }` or
`source: { bytes: Uint8Array }`. With a trusted tool context, use
`sandbox.writeBytes(tc, { path, source, maxBytes? })`. Host wrappers own storage
attachment/ownership checks; never accept model-supplied scope facts or storage
ids without authorization. The `(ctx, ...)` overload trusts the `subject`,
`threadId` and `runId` you pass: derive them from host-owned rows, never from model
or request input. The result is `{ bytes, sha256 }`.

Writes share the export bounds: 8 MiB by default, 64 MiB through
`sandboxNodeWrite(options)` exported from a host `"use node"` file and registered
as `nodeWrite`. Node delegation accepts storage sources only; it never forwards
a large binary action argument. `maxBytes` may lower the registered bound
(including zero for empty files). Oversize writes throw `SandboxWriteError`
with code `SANDBOX_WRITE_TOO_LARGE`.

Each provider receives at most 512 KiB per window (an upload plus one append script
per window). Every attempt stages in its own hidden sibling of the target,
`.agevex-write-<hash of path>-<random id>.tmp`, so overlapping writers never touch
each other's stage. The stage is verified by size and SHA-256 before an atomic
rename, so the target is never mixed or partial: the last committed writer wins and
an interruption preserves the existing target. A new file is created `0666` and
follows the sandbox umask; an existing regular target keeps its permission bits
(ownership is not copied). Exact duplicate windows are no-ops; gaps,
conflicting bytes and partial overlaps throw `SANDBOX_WRITE_OFFSET_MISMATCH`.
Explicit retries restart from offset zero with a fresh stage. Failure cleanup
removes the attempt's stage; if an action dies first, a later write to the same path
removes that path's abandoned `.agevex-write-<hash>-*.tmp` stages and windows once
they are an hour old (a live attempt is cut off after 540 s). That sweep reads at
most 4,096 entries of the target's directory and removes at most 16 files; there
are no timers or file registry. Typed `SandboxWriteError` codes are preserved when
the write runs in the Node action.

| File                          | Responsibility                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `component/state.ts`          | Stable registered `state.*` queries and mutations; runs in Convex.                        |
| `component/admission.ts`      | Transactional sandbox/job admission and complete row builders.                            |
| `component/state_helpers.ts`  | Indexed lookups, active-job probes, safe wake cancellation and terminal transitions.      |
| `component/schema.ts`         | Scope bindings in `sandboxes`; fenced finite watchdogs in `jobs`.                         |
| `component/convex.config.ts`  | Optional component declaration.                                                           |
| `component/_generated/`       | Component API and data-model types.                                                       |
| `client/index.ts`             | Host factory, public exports and core completion adapter.                                 |
| `client/runtime-context.ts`   | Validated context, attribution, authorization, action deadlines and usage observations.   |
| `client/lifecycle.ts`         | Prepare, stop, delete, cleanup scheduling and reconciliation reads.                       |
| `client/execution.ts`         | Bounded commands and persist-before-launch background jobs.                               |
| `client/files.ts`             | Bounded text reads, writes and directory listings.                                        |
| `client/tools.ts`             | SDK tools, once-tool bindings and root-conversation slot.                                 |
| `client/watchdog.ts`          | Host wake/poll/settle/cleanup builders and bounded status/kill decisions.                 |
| `client/export.ts`            | Existing-filesystem authorization, windowed downloads, hashing and native Agent storage.  |
| `client/write.ts`             | Authorized bounded binary writes, storage-only Node delegation and staged commit.         |
| `client/daytona.ts`           | Public Daytona adapter factory.                                                           |
| `client/daytona-context.ts`   | SDK context and bounded Python transport.                                                 |
| `client/daytona-lifecycle.ts` | Create, recover/resume, stop and delete builders.                                         |
| `client/daytona-process.ts`   | Command supervision, background launch, status and ownership-checked cancellation.        |
| `client/daytona-files.ts`     | Source-bounded file operations and staged binary windows.                                 |
| `client/daytona-write.ts`     | Binary window uploads, offset checks, verified atomic rename, mode and stale-stage sweep. |
| `client/types.ts`             | Host/provider contracts and callback types.                                               |
| `shared/limits.ts`            | Pure bounds and validation shared by host and component.                                  |
| `test.ts`                     | Offline convex-test component registration.                                               |

A use reserves its scope, persists the provider identity, resumes it and checks
its claim again. Background admission persists the reconciliation location and
watchdog before launch. Wake claims and schedules atomically; safe status reads
retry until the deadline, while uncertain paid commands never replay. Settlement
and the host completion callback commit together. The last terminal job rearms
idle cleanup; an uncertain delete remains available for host reconciliation.
