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
   `coordinate`, `textTask` and the host helpers.
2. **Accept.** `open` / `send` (`endpoints/requests.ts`) authorize the subject,
   dedupe the request key (a replay returns its stored receipt), run agevex's own
   rejection checks, call the host's optional `admit` for fresh requests only,
   then save the native prompt and call `turns.send.accept`,
   which snapshots validated Agent.run settings for the root and all children.
3. **Schedule.** The component's Workflow loop schedules `runTurn` once per turn
   slice.
4. **Claim.** `turn/claim.ts` checks the execution row and claims the turn
   (`turns.slices.claim`, which also delivers pending notes).
5. **Admit.** `turn/admission.ts` re-runs `authorizeExecution` and the budget slot.
6. **Generate.** `turn/generation.ts` starts the cancellation fence
   (`turn/fence.ts`), runs extract admission and `beforeTurn` / model routing
   (`turn/routing.ts`), builds the tool set with hooks and collaboration tools
   (`turn/tools.ts`, `turn/collaboration-tools.ts`) and runs one native stream or
   generate step. `turn/deadlines.ts` separates provider/tool deadlines and caps
   serial tools; claim derives its watchdog from the accepted run snapshot.
7. **Continue or complete.** `turn/completion.ts` continues after tool calls, runs
   the `afterTurn` notification.
8. **Finish.** `turn/finish.ts` calls `turns.slices.finish`; a child turn first settles its
   run (`coordinate/settle.ts`) and delivers the result (`coordinate/delivery.ts`).
9. **Reconcile.** Every slice exit calls the optional usage adapter's bounded
   sweep. It reads saved provider ids and corrects existing charges; generation
   is never repeated. Observation failures leave a sticky partial run marker.

Collaboration tools call the `coordinate` mutation
(`coordinate/coordinator.ts`), which runs each op in one transaction.

## Reactive run tree

`runTree({ threadId, rootRunId? })` authorizes the owned root thread and returns
`{ rootRunId, usage, nodes } | null`. This breaks the previous descendant-array
contract: consume `.nodes`, including the root. Explicit ids select history
only within that thread. One query tracks projected queued/running/asleep/done/
failed statuses, timestamps, current local tool and exact
message links. Finished nodes never show tools. Transcript bodies stay native.

`usage.view` runs in the host query, after authorization; without it all usage
is null. Meter supplies exclusive per-node totals and the request total, keeping
estimates and settled cost distinct. `delegations` retains paginated stored-state
history. `turn/tools.ts` records bounded progress around local tools and streams;
slice/turn/cancellation fences clear it even if the action does not return.

`afterTurn(hc, { turn, text, messageIds })` reports every successful native
assistant save in the reporting turn, in save order, across tool slices and
approval pauses/resumes. Assistant tool calls count; separate native tool-result
rows, pending/failed placeholders and fenced-out saves do not. A pause emits no
hook until the turn completes. `text` retains its existing meaning: successful
assistant text from the **completing slice**, joined with newlines. Read earlier
narration by exact id. No transcript listing or text matching is involved.

The assignment accumulates ids in the native save transaction. One assistant
row per step bounds the list by run `stepsPerTurn` and any non-default host
`slicesPerTurn` cap (matching Workflow v1): at most 64 ids × (37 ASCII bytes + 2 Convex string bytes) = 2,496 bytes.
Prompt/cap/resume metadata brings the reservation to 3 KiB within the 16 KiB
assignment envelope. New user/queued/child work starts fresh lists; approval
resumes retain the list and step count.
So approving a call requested on the turn's last allowed step ends the turn with
`SLICE_LIMIT` (`recovery_required`) before the approved tool runs. Give `stepsPerTurn`
(and any host `slicesPerTurn`) headroom when tools need approval.

`ToolContext.promptMessageId?: string` comes from the trusted component claim,
never tool input. It identifies the user request or child's task that started
this reporting turn and stays fixed across tool continuations and approval
resumes. The native generation anchor can advance independently to an approval
response. Contexts without a managed prompt may omit the id; hooks inherit it.

## Background text

`text/options.ts` validates default-on title policy and on-demand summary
settings. Hosts export `textTask` and supply `refs.textTask`, or opt
out with `title: false` while leaving summary off. `endpoints/text.ts` authorizes
root title/rename/summary/summarize operations. `text/task.ts` rechecks execution
policy (`purpose: title | summary`) and budget, reads the exact title message or a bounded native summary page,
and invokes a receipt-backed generation without tools or repairs. Usage records the
triggering run, purpose and exact provider response id; evidence failures mark
reporting partial and cannot retry the model. Title and summary text live only on the native Agent thread. Dispatch starts the paid lease; preparation
can be cancelled without an unknown outcome. Native app titles always win.

## File map

| File                          | What is in it                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `index.ts`                    | Public exports of the package.                                                  |
| `runtime.ts`                  | `registerAgent`: composes everything below.                                     |
| `agent.ts`                    | The managed `Agent` class (native Agent plus graph metadata).                   |
| `types.ts`                    | Public types: hooks, registration, scopes, events, coordinator args.            |
| `slots.ts`                    | Optional slot contracts and the replay-stable scoped meter.                     |
| `once.ts`                     | `defineOnceTool` / `bindOnceTool`: exactly-once tools on the receipts ledger.   |
| `tasks.ts`                    | `defineTask` / `runTask`: one structured model call per receipt.                |
| `keys.ts`                     | `fingerprint` and `opaqueKey`.                                                  |
| `tool-names.ts`               | Reserved managed tool names.                                                    |
| `native-saves.ts`             | Native saves whose exact id is recorded in the same transaction.                |
| `registration/context.ts`     | `RuntimeContext`, registration checks, `observe`, `coordinateRef`.              |
| `registration/graph.ts`       | Delegation graph validation and resolution.                                     |
| `endpoints/index.ts`          | `authorizedEndpoints`: composes the public endpoints.                           |
| `endpoints/access.ts`         | Endpoint context and the owned-thread authorization scopes.                     |
| `endpoints/requests.ts`       | `open`, `send`.                                                                 |
| `endpoints/attachments.ts`    | File validation and native file parts for `open` / `send`.                      |
| `endpoints/controls.ts`       | `respond`, `answer`, `cancel`.                                                  |
| `endpoints/reads.ts`          | `messages`, `streams`, `activity`, `runTree`, `delegations`.                    |
| `coordinate/coordinator.ts`   | The `coordinate` mutation and op dispatch.                                      |
| `coordinate/launch.ts`        | `launch`: start a child run.                                                    |
| `coordinate/interaction.ts`   | `message` and `ask` between parent and child.                                   |
| `coordinate/parent-note.ts`   | `message_parent`: receipt-backed progress to the immediate parent.              |
| `coordinate/settle.ts`        | `settle`: record a child run's verified outcome.                                |
| `coordinate/delivery.ts`      | `notify` and one-shot delivery to the parent.                                   |
| `coordinate/verify.ts`        | Child-result verification against the native transcript.                        |
| `host/files.ts`               | `registerFile`, `fileAttached`.                                                 |
| `host/notes.ts`               | `note`, `sandboxComplete`, `postNote`.                                          |
| `turn/run-turn.ts`            | The `runTurn` action: the order of the turn phases.                             |
| `turn/context.ts`             | `Turn`, `Generation`, `TurnOutcome` and the fence predicates.                   |
| `turn/claim.ts`               | Load the execution and claim the turn.                                          |
| `turn/admission.ts`           | `authorizeExecution` and the budget check.                                      |
| `turn/usage.ts`               | Fail-open evidence and bounded reconciliation on slice exit.                    |
| `turn/provider-evidence.ts`   | Preserve exact provider response ids in native saved metadata.                  |
| `turn/fence.ts`               | Cancellation deadline, poll and the fenced action context.                      |
| `turn/generation.ts`          | One generation: phases, native model step, failure mapping.                     |
| `turn/hook-runner.ts`         | Validated hook calls and hook notes.                                            |
| `turn/routing.ts`             | Stateless `beforeTurn` model choice per generation.                             |
| `turn/tools.ts`               | Tool set: slot tools, receipts binding, tool hooks.                             |
| `turn/collaboration-tools.ts` | Managed delegation, parent/child messages and blocking parent questions.        |
| `turn/completion.ts`          | Post-step decisions: tool continuation, `afterTurn` notification, child result. |
| `turn/finish.ts`              | Finish the turn; settle and deliver for a child.                                |
| `turn/slots.ts`               | Usage, extract, sandbox and telemetry slots during a turn.                      |
| `turn/download.ts`            | Byte-bounded attachment downloads for one generation.                           |
