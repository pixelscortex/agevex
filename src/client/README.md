# Client (host runtime)

The code a host imports as `agevex`. It runs inside the host's Convex functions
and drives the component (`src/component`) through its public API. The runtime
modules (`coordinate/`, `turn/`, `host/`) receive the resolved registration
explicitly (`rt: RuntimeContext`). The public endpoints are built from
`(component, config)` instead: `endpoints/access.ts` resolves its own limits and
agent index, and `open` looks roots up in `config.agents`.

## Life of a turn

1. **Register.** `registerAgent` (`runtime.ts`) validates the agent graph, slots
   and models once (`registration/`) and returns the endpoints, `runTurn`,
   `coordinate` and the host helpers.
2. **Accept.** `open` / `send` (`endpoints/requests.ts`) authorize the subject,
   dedupe the request key, save the native prompt and call `queue.accept`.
3. **Schedule.** The component's Workflow loop schedules `runTurn` once per turn
   slice.
4. **Claim.** `turn/claim.ts` checks the execution row and claims the turn
   (`queue.claim`, which also delivers pending notes).
5. **Admit.** `turn/admission.ts` re-runs `authorizeExecution` and the budget slot.
6. **Generate.** `turn/generation.ts` starts the cancellation fence
   (`turn/fence.ts`), runs extract admission and `beforeTurn` / model routing
   (`turn/routing.ts`), builds the tool set with hooks and collaboration tools
   (`turn/tools.ts`, `turn/collaboration-tools.ts`) and runs one native model step.
7. **Continue or complete.** `turn/completion.ts` continues after tool calls, runs
   `afterTurn`, launches side reviews and admits continuations.
8. **Finish.** `turn/finish.ts` calls `queue.finish`; a child turn first settles its
   run (`coordinate/settle.ts`) and delivers the result (`coordinate/delivery.ts`).

Collaboration tools and side reviews call the `coordinate` mutation
(`coordinate/coordinator.ts`), which runs each op in one transaction.

## File map

| File                          | What is in it                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `index.ts`                    | Public exports of the package.                                                |
| `runtime.ts`                  | `registerAgent`: composes everything below.                                   |
| `agent.ts`                    | The managed `Agent` class (native Agent plus graph metadata).                 |
| `types.ts`                    | Public types: hooks, registration, scopes, events, coordinator args.          |
| `slots.ts`                    | Optional slot contracts and the replay-stable scoped meter.                   |
| `once.ts`                     | `defineOnceTool` / `bindOnceTool`: exactly-once tools on the receipts ledger. |
| `tasks.ts`                    | `defineTask` / `runTask`: one structured model call per receipt.              |
| `keys.ts`                     | `fingerprint` and `opaqueKey`.                                                |
| `tool-names.ts`               | Reserved managed tool names.                                                  |
| `native-saves.ts`             | Native saves whose exact id is recorded in the same transaction.              |
| `registration/context.ts`     | `RuntimeContext`, registration checks, `observe`, `coordinateRef`.            |
| `registration/graph.ts`       | Delegation graph validation and resolution.                                   |
| `endpoints/index.ts`          | `authorizedEndpoints`: composes the public endpoints.                         |
| `endpoints/access.ts`         | Endpoint context and the `ownedThread` authorization gate.                    |
| `endpoints/requests.ts`       | `open`, `send`.                                                               |
| `endpoints/attachments.ts`    | File validation and native file parts for `open` / `send`.                    |
| `endpoints/controls.ts`       | `respond`, `answer`, `cancel`.                                                |
| `endpoints/reads.ts`          | `messages`, `streams`, `activity`, `runTree`, `delegations`.                  |
| `coordinate/coordinator.ts`   | The `coordinate` mutation and op dispatch.                                    |
| `coordinate/launch.ts`        | `launch`: start a child run or side review.                                   |
| `coordinate/interaction.ts`   | `message` and `ask` between parent and child.                                 |
| `coordinate/settle.ts`        | `settle`: record a child run's verified outcome.                              |
| `coordinate/delivery.ts`      | `notify` and one-shot delivery to the parent.                                 |
| `coordinate/verify.ts`        | Child-result verification against the native transcript.                      |
| `host/files.ts`               | `registerFile`, `fileAttached`.                                               |
| `host/notes.ts`               | `note`, `sandboxComplete`, `postNote`.                                        |
| `turn/run-turn.ts`            | The `runTurn` action: the order of the turn phases.                           |
| `turn/context.ts`             | `Turn`, `Generation`, `TurnOutcome` and the fence predicates.                 |
| `turn/claim.ts`               | Load the execution and claim the turn.                                        |
| `turn/admission.ts`           | `authorizeExecution` and the budget check.                                    |
| `turn/fence.ts`               | Cancellation deadline, poll and the fenced action context.                    |
| `turn/generation.ts`          | One generation: phases, native model step, failure mapping.                   |
| `turn/hook-runner.ts`         | Validated hook calls and hook notes.                                          |
| `turn/routing.ts`             | `beforeTurn` model choice and per-agent routing.                              |
| `turn/tools.ts`               | Tool set: slot tools, receipts binding, tool hooks.                           |
| `turn/collaboration-tools.ts` | `agevex_delegate`, `agevex_message_child`, `agevex_ask_parent`.               |
| `turn/completion.ts`          | Post-step decisions: continue, `afterTurn`, side reviews, child result.       |
| `turn/finish.ts`              | Finish the turn; settle and deliver for a child.                              |
| `turn/slots.ts`               | Usage, extract, sandbox and telemetry slots during a turn.                    |
| `turn/download.ts`            | Byte-bounded attachment downloads for one generation.                         |
